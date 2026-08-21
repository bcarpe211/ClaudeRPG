#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0 /absolute/path/to/local-runtime-raiders-beta-release" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
case "$1" in http://*|https://*) echo "signed verifier refuses URLs" >&2; exit 64 ;; esac
[ -d "$1" ] && [ ! -L "$1" ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
SOURCE_RELEASE_DIR="$(cd "$1" && pwd -P)"
OWNER="$(/usr/bin/id -u)"
ARCHIVE_MAX_BYTES=8388608

invalid_test_tools() {
  echo "signed verifier test tool configuration is invalid" >&2
  exit 64
}

validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) invalid_test_tools ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || invalid_test_tools
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || invalid_test_tools
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || invalid_test_tools
}

if [ -n "${RUNTIME_RAIDERS_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_TEST_MODE" = 1 ] &&
    [ "${RUNTIME_RAIDERS_TEST_ROOT:-}" = "$ROOT" ] || invalid_test_tools
  LIPO_TOOL="${RUNTIME_RAIDERS_TEST_LIPO:-}"
  CODESIGN_TOOL="${RUNTIME_RAIDERS_TEST_CODESIGN:-}"
  SPCTL_TOOL="${RUNTIME_RAIDERS_TEST_SPCTL:-}"
  XCRUN_TOOL="${RUNTIME_RAIDERS_TEST_XCRUN:-}"
  COPY_HOOK="${RUNTIME_RAIDERS_TEST_COPY_HOOK:-}"
  for test_tool in "$LIPO_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$XCRUN_TOOL"; do
    validate_test_tool "$test_tool"
  done
  [ -z "$COPY_HOOK" ] || validate_test_tool "$COPY_HOOK"
else
  for injected_name in \
    RUNTIME_RAIDERS_TEST_ROOT RUNTIME_RAIDERS_TEST_LIPO RUNTIME_RAIDERS_TEST_CODESIGN \
    RUNTIME_RAIDERS_TEST_SPCTL RUNTIME_RAIDERS_TEST_XCRUN RUNTIME_RAIDERS_TEST_COPY_HOOK; do
    [ -z "${!injected_name:-}" ] || invalid_test_tools
  done
  COPY_HOOK=''
  LIPO_TOOL=/usr/bin/lipo
  CODESIGN_TOOL=/usr/bin/codesign
  SPCTL_TOOL=/usr/sbin/spctl
  XCRUN_TOOL=/usr/bin/xcrun
fi
for system_tool in "$LIPO_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$XCRUN_TOOL"; do
  [ -x "$system_tool" ] || {
    echo "required verifier tool is unavailable: $system_tool" >&2
    exit 69
  }
done

REVIEWED_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || {
  echo "signed verifier could not inspect reviewed source" >&2
  exit 1
}
[ -z "$REVIEWED_STATUS" ] || {
  echo "reviewed source must be clean" >&2
  exit 1
}
REVIEWED_HEAD="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || {
  echo "signed verifier could not inspect reviewed source" >&2
  exit 1
}
[[ "$REVIEWED_HEAD" =~ ^[0-9a-f]{40}$ ]] || {
  echo "reviewed HEAD is invalid" >&2
  exit 1
}

RELEASE_FILE="$ROOT/companion/RELEASE"
[ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ] || {
  echo "companion/RELEASE is invalid" >&2
  exit 1
}
REVIEWED_VERSION_LINE="$(/usr/bin/sed -n '2p' "$RELEASE_FILE")"
case "$REVIEWED_VERSION_LINE" in
  companion_version=*) REVIEWED_VERSION="${REVIEWED_VERSION_LINE#companion_version=}" ;;
  *) echo "companion/RELEASE is invalid" >&2; exit 1 ;;
esac
[[ "$REVIEWED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
  /usr/bin/cmp -s "$RELEASE_FILE" <(printf 'format=1\ncompanion_version=%s\n' "$REVIEWED_VERSION") || {
  echo "companion/RELEASE is invalid" >&2
  exit 1
}

SMOKE_ROOT=''
WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-beta-verify.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$SMOKE_ROOT" ]; then
    if [[ "$SMOKE_ROOT" == /private/tmp/rrv.?????? ]] &&
      [ -d "$SMOKE_ROOT" ] && [ ! -L "$SMOKE_ROOT" ] &&
      [ "$(/usr/bin/stat -f '%u' "$SMOKE_ROOT")" = "$OWNER" ]; then
      /bin/rm -rf -- "$SMOKE_ROOT" || status=1
    else
      status=1
    fi
  fi
  if [[ "$WORK" == "${TMPDIR:-/tmp}"/runtime-raiders-beta-verify.* ]]; then
    /bin/rm -rf -- "$WORK" || status=1
  else
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(/usr/bin/stat -f '%u' "$SOURCE_RELEASE_DIR")" = "$OWNER" ] || {
  echo "signed verifier refuses an unowned release directory" >&2
  exit 1
}
release_mode="$(/usr/bin/stat -f '%Lp' "$SOURCE_RELEASE_DIR")"
(( (8#$release_mode & 8#022) == 0 )) || {
  echo "release directory must not be group or world writable" >&2
  exit 1
}
[ "$(/usr/bin/find "$SOURCE_RELEASE_DIR" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || {
  echo "signed verifier requires exactly three public files and release-summary.txt" >&2
  exit 1
}

release_directory_snapshot() {
  local directory="$1" name member mode
  [ -d "$directory" ] && [ ! -L "$directory" ] &&
    [ "$(/usr/bin/stat -f '%u' "$directory")" = "$OWNER" ] || return 1
  mode="$(/usr/bin/stat -f '%Lp' "$directory")"
  (( (8#$mode & 8#022) == 0 )) || return 1
  [ "$(/usr/bin/find "$directory" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || return 1
  printf 'directory:%s\n' "$(/usr/bin/stat -f '%u:%g:%l:%Lp:%d:%i:%z:%m:%c' "$directory")"
  for name in install.sh runtime-raiders-agent.zip version release-summary.txt; do
    member="$directory/$name"
    [ -f "$member" ] && [ ! -L "$member" ] &&
      [ "$(/usr/bin/stat -f '%u' "$member")" = "$OWNER" ] &&
      [ "$(/usr/bin/stat -f '%l' "$member")" = 1 ] || return 1
    mode="$(/usr/bin/stat -f '%Lp' "$member")"
    (( (8#$mode & 8#022) == 0 )) || return 1
    printf '%s:%s:' "$name" "$(/usr/bin/stat -f '%u:%g:%l:%Lp:%d:%i:%z:%m:%c' "$member")"
    /usr/bin/shasum -a 256 "$member" | /usr/bin/awk 'NR == 1 { print $1 }'
  done
}
SOURCE_RELEASE_SNAPSHOT="$(release_directory_snapshot "$SOURCE_RELEASE_DIR")" || {
  echo "signed verifier could not snapshot the release directory" >&2
  exit 1
}

INPUT="$WORK/input"
/bin/mkdir -m 700 "$INPUT"
copy_release_member() {
  local name="$1" destination_mode="$2" source="$SOURCE_RELEASE_DIR/$1"
  local before after mode copied="$INPUT/$1"
  [ -f "$source" ] && [ ! -L "$source" ] &&
    [ "$(/usr/bin/stat -f '%u' "$source")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$source")" = 1 ] || {
    echo "signed verifier refuses an unsafe release member" >&2
    exit 1
  }
  mode="$(/usr/bin/stat -f '%Lp' "$source")"
  (( (8#$mode & 8#022) == 0 )) || {
    echo "signed verifier refuses writable release members" >&2
    exit 1
  }
  before="$(/usr/bin/stat -f '%u:%l:%Lp:%d:%i:%z:%m:%c' "$source")"
  /bin/cp "$source" "$copied"
  after="$(/usr/bin/stat -f '%u:%l:%Lp:%d:%i:%z:%m:%c' "$source")"
  [ "$after" = "$before" ] || {
    echo "release member changed while being copied" >&2
    exit 1
  }
  /bin/chmod "$destination_mode" "$copied"
  [ -f "$copied" ] && [ ! -L "$copied" ] &&
    [ "$(/usr/bin/stat -f '%u' "$copied")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$copied")" = 1 ] || {
    echo "signed verifier could not isolate a release member" >&2
    exit 1
  }
  [ -z "$COPY_HOOK" ] || "$COPY_HOOK" "$name" "$SOURCE_RELEASE_DIR"
}
copy_release_member install.sh 700
copy_release_member runtime-raiders-agent.zip 600
copy_release_member version 600
copy_release_member release-summary.txt 600
COPIED_SOURCE_RELEASE_SNAPSHOT="$(release_directory_snapshot "$SOURCE_RELEASE_DIR")" || {
  echo "release directory changed while making private copies" >&2
  exit 1
}
[ "$COPIED_SOURCE_RELEASE_SNAPSHOT" = "$SOURCE_RELEASE_SNAPSHOT" ] || {
  echo "release directory changed while making private copies" >&2
  exit 1
}

INSTALLER="$INPUT/install.sh"
ARCHIVE="$INPUT/runtime-raiders-agent.zip"
VERSION_FILE="$INPUT/version"
SUMMARY="$INPUT/release-summary.txt"
[ -x "$INSTALLER" ] || {
  echo "signed verifier requires executable install.sh" >&2
  exit 1
}

/usr/bin/cmp -s "$VERSION_FILE" <(printf '{"version":"%s"}\n' "$REVIEWED_VERSION") || {
  echo "release files do not match companion/RELEASE" >&2
  exit 1
}
COMPANION_VERSION="$REVIEWED_VERSION"

INSTALLER_VERSION="$(/usr/bin/sed -n "s/^COMPANION_VERSION='\([^']*\)'$/\1/p" "$INSTALLER")"
TEAM_ID="$(/usr/bin/sed -n "s/^TEAM_ID='\([^']*\)'$/\1/p" "$INSTALLER")"
[ "$INSTALLER_VERSION" = "$COMPANION_VERSION" ] && [[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "installer version or Team ID is invalid" >&2
  exit 1
}
EXPECTED_INSTALLER="$WORK/expected-install.sh"
/usr/bin/sed \
  -e "s/__RUNTIME_RAIDERS_COMPANION_VERSION__/$COMPANION_VERSION/g" \
  -e "s/__RUNTIME_RAIDERS_TEAM_ID__/$TEAM_ID/g" \
  "$ROOT/companion/packaging/install.sh" > "$EXPECTED_INSTALLER"
/usr/bin/cmp -s "$INSTALLER" "$EXPECTED_INSTALLER" || {
  echo "install.sh is not the exact two-value template rendering" >&2
  exit 1
}
if /usr/bin/grep -F '__RUNTIME_RAIDERS_' "$INSTALLER" >/dev/null; then
  echo "install.sh contains an unrendered placeholder" >&2
  exit 1
fi

summary_value() {
  local key="$1"
  /usr/bin/awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$SUMMARY"
}
for key in \
  git_sha companion_version bundle_identifier team_id codesign_verified hardened_runtime \
  secure_timestamp notarization stapled gatekeeper archive_shape install.sh_bytes \
  install.sh_sha256 runtime-raiders-agent.zip_bytes runtime-raiders-agent.zip_sha256 \
  version_bytes version_sha256; do
  summary_value "$key" >/dev/null || {
    echo "release-summary.txt is incomplete" >&2
    exit 1
  }
done
[ "$(/usr/bin/wc -l < "$SUMMARY" | /usr/bin/tr -d ' ')" -eq 17 ] || {
  echo "release-summary.txt contains unexpected fields" >&2
  exit 1
}
[ "$(summary_value git_sha)" = "$REVIEWED_HEAD" ] || {
  echo "release summary does not match reviewed HEAD" >&2
  exit 1
}
[ "$(summary_value companion_version)" = "$COMPANION_VERSION" ] &&
  [ "$(summary_value bundle_identifier)" = com.redlattice.runtime-raiders-agent ] &&
  [ "$(summary_value team_id)" = "$TEAM_ID" ] &&
  [ "$(summary_value codesign_verified)" = true ] &&
  [ "$(summary_value hardened_runtime)" = true ] &&
  [ "$(summary_value secure_timestamp)" = true ] &&
  [ "$(summary_value notarization)" = Accepted ] &&
  [ "$(summary_value stapled)" = true ] &&
  [ "$(summary_value gatekeeper)" = accepted ] &&
  [ "$(summary_value archive_shape)" = one-app ] || {
  echo "release-summary.txt trust facts are invalid" >&2
  exit 1
}

check_summary_file() {
  local label="$1" file="$2" bytes sha
  bytes="$(/usr/bin/wc -c < "$file" | /usr/bin/tr -d ' ')"
  sha="$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk 'NR == 1 { print $1 }')"
  [ "$(summary_value "${label}_bytes")" = "$bytes" ] &&
    [ "$(summary_value "${label}_sha256")" = "$sha" ]
}
check_summary_file install.sh "$INSTALLER" &&
  check_summary_file runtime-raiders-agent.zip "$ARCHIVE" &&
  check_summary_file version "$VERSION_FILE" || {
  echo "release-summary.txt size or SHA-256 evidence does not match" >&2
  exit 1
}
ARCHIVE_BYTES="$(/usr/bin/wc -c < "$ARCHIVE" | /usr/bin/tr -d ' ')"
[ "$ARCHIVE_BYTES" -le "$ARCHIVE_MAX_BYTES" ] || {
  echo "release archive exceeds $ARCHIVE_MAX_BYTES bytes" >&2
  exit 1
}
ARCHIVE_SHA256="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk 'NR == 1 { print $1 }')"

EXTRACTED="$WORK/extracted"
/bin/mkdir "$EXTRACTED"
/usr/bin/ditto -x -k "$ARCHIVE" "$EXTRACTED"
AGENT_APP="$EXTRACTED/Runtime Raiders.app"
AGENT_INFO="$AGENT_APP/Contents/Info.plist"
AGENT_EXECUTABLE="$AGENT_APP/Contents/MacOS/runtime-raiders-agent"
AGENT_ICON="$AGENT_APP/Contents/Resources/RuntimeRaiders.icns"
[ "$(/usr/bin/find "$EXTRACTED" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ -d "$AGENT_APP" ] && [ ! -L "$AGENT_APP" ] &&
  [ -z "$(/usr/bin/find "$EXTRACTED" -type l -print -quit)" ] &&
  [ -f "$AGENT_INFO" ] && [ ! -L "$AGENT_INFO" ] &&
  [ -f "$AGENT_ICON" ] && [ ! -L "$AGENT_ICON" ] && [ -s "$AGENT_ICON" ] &&
  [ -x "$AGENT_EXECUTABLE" ] && [ ! -L "$AGENT_EXECUTABLE" ] || {
  echo "archive does not contain exactly one safe Runtime Raiders.app" >&2
  exit 1
}

BUNDLE_ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$AGENT_INFO")"
BUNDLE_EXECUTABLE="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$AGENT_INFO")"
BUNDLE_NAME="$(/usr/bin/plutil -extract CFBundleName raw -o - "$AGENT_INFO")"
BUNDLE_DISPLAY_NAME="$(/usr/bin/plutil -extract CFBundleDisplayName raw -o - "$AGENT_INFO")"
BUNDLE_ICON_FILE="$(/usr/bin/plutil -extract CFBundleIconFile raw -o - "$AGENT_INFO")"
BUNDLE_SHORT_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$AGENT_INFO")"
BUNDLE_VERSION="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$AGENT_INFO")"
[ "$BUNDLE_ID" = com.redlattice.runtime-raiders-agent ] &&
  [ "$BUNDLE_EXECUTABLE" = runtime-raiders-agent ] &&
  [ "$BUNDLE_NAME" = 'Runtime Raiders' ] &&
  [ "$BUNDLE_DISPLAY_NAME" = 'Runtime Raiders' ] &&
  [ "$BUNDLE_ICON_FILE" = RuntimeRaiders ] &&
  [ "$BUNDLE_SHORT_VERSION" = "$COMPANION_VERSION" ] &&
  [ "$BUNDLE_VERSION" = "$COMPANION_VERSION" ] || {
  echo "archive bundle identity or version is invalid" >&2
  exit 1
}

"$LIPO_TOOL" "$AGENT_EXECUTABLE" -verify_arch arm64 x86_64
CODESIGN_FACTS="$("$CODESIGN_TOOL" -dv --verbose=4 "$AGENT_APP" 2>&1)"
printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -F "TeamIdentifier=$TEAM_ID" >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E 'flags=.*runtime' >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E '^Timestamp=.+' >/dev/null || {
  echo "archive signing facts are invalid" >&2
  exit 1
}
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'
"$CODESIGN_TOOL" --verify --deep --strict --verbose=2 "$AGENT_APP"
"$CODESIGN_TOOL" --verify --strict "-R=$AGENT_REQUIREMENT" "$AGENT_APP"
"$SPCTL_TOOL" --assess --type execute --verbose=2 "$AGENT_APP"
"$XCRUN_TOOL" stapler validate "$AGENT_APP"
VERIFIED_ICONSET="$WORK/verified-icon.iconset"
/usr/bin/iconutil -c iconset "$AGENT_ICON" -o "$VERIFIED_ICONSET" >/dev/null 2>&1 &&
  [ -f "$VERIFIED_ICONSET/icon_512x512@2x.png" ] &&
  [ ! -L "$VERIFIED_ICONSET/icon_512x512@2x.png" ] &&
  [ -s "$VERIFIED_ICONSET/icon_512x512@2x.png" ] || {
  echo "archive icon resource is invalid" >&2
  exit 1
}
VERIFIED_EXECUTABLE_SHA256="$(/usr/bin/shasum -a 256 "$AGENT_EXECUTABLE" | /usr/bin/awk 'NR == 1 { print $1 }')"

PRIVATE_TMP="$(cd /private/tmp && pwd -P)"
[ "$PRIVATE_TMP" = /private/tmp ] && [ -d /private/tmp ] && [ ! -L /private/tmp ] || {
  echo "signed verifier requires physical /private/tmp for smoke" >&2
  exit 1
}
SMOKE_ROOT="$(/usr/bin/mktemp -d /private/tmp/rrv.XXXXXX)"
[[ "$SMOKE_ROOT" == /private/tmp/rrv.?????? ]] &&
  [ -d "$SMOKE_ROOT" ] && [ ! -L "$SMOKE_ROOT" ] &&
  [ "$(/usr/bin/stat -f '%u' "$SMOKE_ROOT")" = "$OWNER" ] &&
  [ "$(/usr/bin/stat -f '%Lp' "$SMOKE_ROOT")" = 700 ] || {
  echo "signed verifier could not create a safe short smoke root" >&2
  exit 1
}
SMOKE_HOME="$SMOKE_ROOT/home"
SMOKE_SOCKET_PATH="$SMOKE_HOME/Library/Application Support/Runtime Raiders/agent.sock"
[ "$(printf %s "$SMOKE_SOCKET_PATH" | /usr/bin/wc -c | /usr/bin/tr -d ' ')" -lt 104 ] || {
  echo "signed verifier smoke socket path is unsafe" >&2
  exit 1
}
SMOKE_BIN="$WORK/fake-bin"
SMOKE_LOG="$WORK/smoke.log"
LOCAL_VERSION="$WORK/version-response"
/bin/mkdir -p "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/outbox" "$SMOKE_BIN"
/bin/chmod 700 "$SMOKE_HOME" "$SMOKE_HOME/Library" "$SMOKE_HOME/Library/Application Support" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/outbox" "$SMOKE_BIN"
cat > "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/enrollment.json" <<'EOF'
{"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","server_url":"https://raiders.redlattice.com","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}
EOF
/bin/chmod 600 "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/enrollment.json"
printf '{"version":"%s"}\n' "$COMPANION_VERSION" > "$LOCAL_VERSION"
/bin/chmod 600 "$LOCAL_VERSION"
: > "$SMOKE_LOG"

cat > "$SMOKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu
output=''; url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output=$2; shift 2 ;;
    --write-out|-w|--proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--max-filesize|-X|-H|--data-binary) shift 2 ;;
    --fail|--silent|--show-error|-f|-s|-S) shift ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$url" = https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip ] || exit 97
printf 'LOCAL_ARCHIVE\n' >> "$RR_VERIFY_SMOKE_LOG"
/bin/cp "$RR_VERIFY_ARCHIVE" "$output"
printf 200
EOF
cat > "$SMOKE_BIN/ditto" <<'EOF'
#!/bin/sh
set -eu
exec /usr/bin/ditto "$@"
EOF
cat > "$SMOKE_BIN/codesign" <<'EOF'
#!/bin/sh
set -eu
last=''; for last in "$@"; do :; done
case "$last" in
  "$RR_VERIFY_SMOKE_HOME"'/Library/Application Support/Runtime Raiders/.runtime-raiders-install.'*'/unpacked/Runtime Raiders.app') : ;;
  *) exit 65 ;;
esac
if [ "$#" -eq 5 ] && [ "$1" = --verify ] && [ "$2" = --deep ] && [ "$3" = --strict ] && [ "$4" = --verbose=2 ]; then
  printf 'codesign:deep\n' >> "$RR_VERIFY_SMOKE_LOG"
  exit 0
fi
if [ "$#" -eq 4 ] && [ "$1" = --verify ] && [ "$2" = --strict ]; then
  expected_requirement='-R=identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RR_VERIFY_TEAM_ID"'"'
  [ "$3" = "$expected_requirement" ] || exit 65
  printf 'codesign:requirement\n' >> "$RR_VERIFY_SMOKE_LOG"
  exit 0
fi
exit 64
EOF
cat > "$SMOKE_BIN/spctl" <<'EOF'
#!/bin/sh
set -eu
last=''; for last in "$@"; do :; done
case "$last" in *'/unpacked/Runtime Raiders.app') : ;; *) exit 65 ;; esac
EOF
cat > "$SMOKE_BIN/launchctl" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  bootout) printf 'launchctl bootout\n' >> "$RR_VERIFY_SMOKE_LOG" ;;
  bootstrap) printf 'launchctl bootstrap\n' >> "$RR_VERIFY_SMOKE_LOG" ;;
  *) exit 64 ;;
esac
EOF
/bin/chmod 700 "$SMOKE_BIN/curl" "$SMOKE_BIN/ditto" "$SMOKE_BIN/codesign" "$SMOKE_BIN/spctl" "$SMOKE_BIN/launchctl"

SMOKE_INSTALLER="$WORK/install-smoke.sh"
/usr/bin/sed \
  -e "s|/usr/bin/curl|$SMOKE_BIN/curl|g" \
  -e "s|/usr/bin/ditto|$SMOKE_BIN/ditto|g" \
  -e "s|/usr/bin/codesign|$SMOKE_BIN/codesign|g" \
  -e "s|/usr/sbin/spctl|$SMOKE_BIN/spctl|g" \
  -e "s|/bin/launchctl|$SMOKE_BIN/launchctl|g" \
  "$INSTALLER" > "$SMOKE_INSTALLER"
/bin/chmod 700 "$SMOKE_INSTALLER"

SMOKE_ENV=(
  HOME="$SMOKE_HOME"
  CFFIXED_USER_HOME="$SMOKE_HOME"
  RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS=1
  RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY="$SMOKE_HOME/Library/Application Support"
  RR_VERIFY_SMOKE_LOG="$SMOKE_LOG"
  RR_VERIFY_ARCHIVE="$ARCHIVE"
  RR_VERIFY_SMOKE_HOME="$SMOKE_HOME"
  RR_VERIFY_TEAM_ID="$TEAM_ID"
)
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "${SMOKE_ENV[@]}" /bin/sh "$SMOKE_INSTALLER" >/dev/null
INSTALLED_COMMAND="$SMOKE_HOME/.local/bin/raiders"
INSTALLED_EXECUTABLE="$SMOKE_HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent"
[ -x "$INSTALLED_COMMAND" ] &&
  [ ! -e "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/collector-state.json" ] &&
  [ "$(/usr/bin/shasum -a 256 "$INSTALLED_EXECUTABLE" | /usr/bin/awk 'NR == 1 { print $1 }')" = "$VERIFIED_EXECUTABLE_SHA256" ] || {
  echo "fake-HOME install did not preserve the verified disabled app" >&2
  exit 1
}
STATUS_OUTPUT="$(/usr/bin/env -i PATH=/usr/bin:/bin "${SMOKE_ENV[@]}" \
  "$INSTALLED_COMMAND" status)"
printf '%s\n' "$STATUS_OUTPUT" | /usr/bin/grep -F '"activationState":"disabled"' >/dev/null || {
  echo "fake-HOME status smoke was not disabled" >&2
  exit 1
}
UPDATE_OUTPUT="$(/usr/bin/env -i PATH=/usr/bin:/bin "${SMOKE_ENV[@]}" \
  RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE="$LOCAL_VERSION" "$INSTALLED_COMMAND" update)"
[ "$UPDATE_OUTPUT" = "Runtime Raiders $COMPANION_VERSION is current." ] &&
  [ "$(/usr/bin/grep -c '^LOCAL_ARCHIVE$' "$SMOKE_LOG")" -eq 1 ] &&
  [ "$(/usr/bin/grep -c '^codesign:deep$' "$SMOKE_LOG")" -eq 1 ] &&
  [ "$(/usr/bin/grep -c '^codesign:requirement$' "$SMOKE_LOG")" -eq 1 ] || {
  echo "fake-HOME local update-check smoke failed" >&2
  exit 1
}
[ "$(/usr/bin/shasum -a 256 "$AGENT_EXECUTABLE" | /usr/bin/awk 'NR == 1 { print $1 }')" = "$VERIFIED_EXECUTABLE_SHA256" ] &&
  [ "$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk 'NR == 1 { print $1 }')" = "$ARCHIVE_SHA256" ] || {
  echo "signed verifier modified verified release bytes" >&2
  exit 1
}

FINAL_SOURCE_RELEASE_SNAPSHOT="$(release_directory_snapshot "$SOURCE_RELEASE_DIR")" || {
  echo "release directory changed during signed verification" >&2
  exit 1
}
[ "$FINAL_SOURCE_RELEASE_SNAPSHOT" = "$SOURCE_RELEASE_SNAPSHOT" ] || {
  echo "release directory changed during signed verification" >&2
  exit 1
}

FINAL_REVIEWED_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || exit 1
FINAL_REVIEWED_HEAD="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || exit 1
[ -z "$FINAL_REVIEWED_STATUS" ] && [ "$FINAL_REVIEWED_HEAD" = "$REVIEWED_HEAD" ] || {
  echo "reviewed source changed during signed verification" >&2
  exit 1
}

echo "Verified local Runtime Raiders beta $COMPANION_VERSION: one trusted app, fresh install off, local update check only."
