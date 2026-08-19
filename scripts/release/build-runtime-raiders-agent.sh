#!/bin/bash

set -euo pipefail

usage() {
  echo "usage: $0" >&2
  exit 64
}

[ "$#" -eq 0 ] || usage
for required_name in RUNTIME_RAIDERS_CODESIGN_IDENTITY RUNTIME_RAIDERS_NOTARY_PROFILE RUNTIME_RAIDERS_TEAM_ID; do
  [ -n "${!required_name:-}" ] || {
    echo "$required_name is required" >&2
    exit 64
  }
done

if [[ ! "$RUNTIME_RAIDERS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "RUNTIME_RAIDERS_TEAM_ID is invalid" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
RELEASE_FILE="$ROOT/companion/RELEASE"
INSTALLER_TEMPLATE="$ROOT/companion/packaging/install.sh"
ARCHIVE_MAX_BYTES=8388608

invalid_test_tools() {
  echo "release test tool configuration is invalid" >&2
  exit 64
}

validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) invalid_test_tools ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || invalid_test_tools
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$(/usr/bin/id -u)" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || invalid_test_tools
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || invalid_test_tools
}

if [ -n "${RUNTIME_RAIDERS_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_TEST_MODE" = 1 ] &&
    [ "${RUNTIME_RAIDERS_TEST_ROOT:-}" = "$ROOT" ] || invalid_test_tools
  SWIFT_TOOL="${RUNTIME_RAIDERS_TEST_SWIFT:-}"
  LIPO_TOOL="${RUNTIME_RAIDERS_TEST_LIPO:-}"
  CODESIGN_TOOL="${RUNTIME_RAIDERS_TEST_CODESIGN:-}"
  SPCTL_TOOL="${RUNTIME_RAIDERS_TEST_SPCTL:-}"
  XCRUN_TOOL="${RUNTIME_RAIDERS_TEST_XCRUN:-}"
  for test_tool in "$SWIFT_TOOL" "$LIPO_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$XCRUN_TOOL"; do
    validate_test_tool "$test_tool"
  done
else
  for injected_name in \
    RUNTIME_RAIDERS_TEST_ROOT RUNTIME_RAIDERS_TEST_SWIFT RUNTIME_RAIDERS_TEST_LIPO \
    RUNTIME_RAIDERS_TEST_CODESIGN RUNTIME_RAIDERS_TEST_SPCTL RUNTIME_RAIDERS_TEST_XCRUN; do
    [ -z "${!injected_name:-}" ] || invalid_test_tools
  done
  SWIFT_TOOL=/usr/bin/swift
  LIPO_TOOL=/usr/bin/lipo
  CODESIGN_TOOL=/usr/bin/codesign
  SPCTL_TOOL=/usr/sbin/spctl
  XCRUN_TOOL=/usr/bin/xcrun
fi
for system_tool in "$SWIFT_TOOL" "$LIPO_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$XCRUN_TOOL"; do
  [ -x "$system_tool" ] || {
    echo "required release tool is unavailable: $system_tool" >&2
    exit 69
  }
done

[ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ] || {
  echo "companion/RELEASE is required" >&2
  exit 64
}
[ "$(/usr/bin/awk 'END { print NR }' "$RELEASE_FILE")" -eq 2 ] &&
  [ "$(/usr/bin/sed -n '1p' "$RELEASE_FILE")" = format=1 ] || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}
COMPANION_VERSION_LINE="$(/usr/bin/sed -n '2p' "$RELEASE_FILE")"
case "$COMPANION_VERSION_LINE" in
  companion_version=*) COMPANION_VERSION="${COMPANION_VERSION_LINE#companion_version=}" ;;
  *) echo "companion/RELEASE is invalid" >&2; exit 64 ;;
esac
[[ "$COMPANION_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "companion_version is invalid" >&2
  exit 64
}
/usr/bin/cmp -s "$RELEASE_FILE" <(printf 'format=1\ncompanion_version=%s\n' "$COMPANION_VERSION") || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}
[ -f "$INSTALLER_TEMPLATE" ] && [ ! -L "$INSTALLER_TEMPLATE" ] || {
  echo "installer template is required" >&2
  exit 64
}

GIT_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || {
  echo "unable to inspect Git worktree" >&2
  exit 64
}
[ -z "$GIT_STATUS" ] || {
  echo "tracked worktree is not clean" >&2
  exit 64
}
GIT_SHA="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || {
  echo "unable to inspect Git HEAD" >&2
  exit 64
}
[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Git HEAD is invalid" >&2
  exit 64
}

OUTPUT_PARENT="$ROOT/dist"
OUTPUT="$OUTPUT_PARENT/runtime-raiders-beta-$COMPANION_VERSION"
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "release output already exists: $OUTPUT" >&2
  exit 1
}
/bin/mkdir -p "$OUTPUT_PARENT"
[ -d "$OUTPUT_PARENT" ] && [ ! -L "$OUTPUT_PARENT" ] || {
  echo "release output parent is unsafe" >&2
  exit 1
}

TEMP_ROOT="${TMPDIR:-/tmp}"
WORK="$(/usr/bin/mktemp -d "$TEMP_ROOT/runtime-raiders-beta-build.XXXXXX")"
STAGED_OUTPUT="$(/usr/bin/mktemp -d "$OUTPUT_PARENT/.runtime-raiders-beta.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "${WORK:-}" ] && [[ "$WORK" == "$TEMP_ROOT"/runtime-raiders-beta-build.* ]]; then
    /bin/rm -rf -- "$WORK" || status=1
  fi
  if [ -n "${STAGED_OUTPUT:-}" ] && [[ "$STAGED_OUTPUT" == "$OUTPUT_PARENT"/.runtime-raiders-beta.* ]]; then
    /bin/rm -rf -- "$STAGED_OUTPUT" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SWIFT_SCRATCH="$WORK/swift"
for arch in arm64 x86_64; do
  (
    cd "$ROOT/companion"
    "$SWIFT_TOOL" build -c release --arch "$arch" --scratch-path "$SWIFT_SCRATCH" --product raiders
  )
  BUILT_BINARY="$SWIFT_SCRATCH/$arch-apple-macosx/release/raiders"
  [ -f "$BUILT_BINARY" ] && [ ! -L "$BUILT_BINARY" ] && [ -x "$BUILT_BINARY" ] || {
    echo "Swift did not produce raiders for $arch" >&2
    exit 1
  }
  /bin/cp "$BUILT_BINARY" "$WORK/raiders-$arch"
done

UNIVERSAL_AGENT="$WORK/runtime-raiders-agent"
"$LIPO_TOOL" -create "$WORK/raiders-arm64" "$WORK/raiders-x86_64" -output "$UNIVERSAL_AGENT"
"$LIPO_TOOL" "$UNIVERSAL_AGENT" -verify_arch arm64 x86_64

AGENT_APP="$WORK/Runtime Raiders Agent.app"
/bin/mkdir -p "$AGENT_APP/Contents/MacOS"
/bin/mv "$UNIVERSAL_AGENT" "$AGENT_APP/Contents/MacOS/runtime-raiders-agent"
/bin/chmod 755 "$AGENT_APP/Contents/MacOS/runtime-raiders-agent"
cat > "$AGENT_APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>runtime-raiders-agent</string>
  <key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>
  <key>CFBundleName</key><string>Runtime Raiders Agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$COMPANION_VERSION</string>
  <key>CFBundleVersion</key><string>$COMPANION_VERSION</string>
</dict>
</plist>
EOF
/usr/bin/plutil -lint "$AGENT_APP/Contents/Info.plist" >/dev/null

validate_bundle_version() {
  local application="$1" info="$1/Contents/Info.plist"
  local bundle_id executable short_version bundle_version
  bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$info")" &&
    executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$info")" &&
    short_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$info")" &&
    bundle_version="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$info")" || return 1
  [ "$bundle_id" = com.redlattice.runtime-raiders-agent ] &&
    [ "$executable" = runtime-raiders-agent ] &&
    [ "$short_version" = "$COMPANION_VERSION" ] &&
    [ "$bundle_version" = "$COMPANION_VERSION" ]
}

validate_bundle_version "$AGENT_APP" || {
  echo "bundle version does not match companion/RELEASE" >&2
  exit 1
}

"$CODESIGN_TOOL" --force --options runtime --timestamp --sign "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" "$AGENT_APP"
validate_bundle_version "$AGENT_APP" || {
  echo "bundle version does not match companion/RELEASE" >&2
  exit 1
}
CODESIGN_FACTS="$("$CODESIGN_TOOL" -dv --verbose=4 "$AGENT_APP" 2>&1)"
printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -F "TeamIdentifier=$RUNTIME_RAIDERS_TEAM_ID" >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E 'flags=.*runtime' >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E '^Timestamp=.+' >/dev/null || {
  echo "signed app is missing Team ID, hardened runtime, or secure timestamp" >&2
  exit 1
}
"$CODESIGN_TOOL" --verify --deep --strict --verbose=2 "$AGENT_APP"

NOTARY_ZIP="$WORK/runtime-raiders-notary.zip"
/usr/bin/ditto -c -k --keepParent "$AGENT_APP" "$NOTARY_ZIP"
NOTARY_RESULT="$("$XCRUN_TOOL" notarytool submit "$NOTARY_ZIP" \
  --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE" --wait)"
printf '%s\n' "$NOTARY_RESULT" | /usr/bin/grep -Ei 'status:[[:space:]]*Accepted' >/dev/null || {
  echo "notarization was not accepted" >&2
  exit 1
}
"$XCRUN_TOOL" stapler staple "$AGENT_APP"
"$XCRUN_TOOL" stapler validate "$AGENT_APP"
"$CODESIGN_TOOL" --verify --deep --strict --verbose=2 "$AGENT_APP"
"$SPCTL_TOOL" --assess --type execute --verbose=2 "$AGENT_APP"

ARCHIVE="$STAGED_OUTPUT/runtime-raiders-agent.zip"
/usr/bin/ditto -c -k --keepParent "$AGENT_APP" "$ARCHIVE"
[ -s "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
  echo "release archive was not created" >&2
  exit 1
}
ARCHIVE_CREATED_BYTES="$(/usr/bin/wc -c < "$ARCHIVE" | /usr/bin/tr -d ' ')"
[ "$ARCHIVE_CREATED_BYTES" -le "$ARCHIVE_MAX_BYTES" ] || {
  echo "release archive exceeds $ARCHIVE_MAX_BYTES bytes" >&2
  exit 1
}

EXTRACTED="$WORK/extracted"
/bin/mkdir "$EXTRACTED"
/usr/bin/ditto -x -k "$ARCHIVE" "$EXTRACTED"
PACKAGED_APP="$EXTRACTED/Runtime Raiders Agent.app"
[ "$(/usr/bin/find "$EXTRACTED" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ -d "$PACKAGED_APP" ] && [ ! -L "$PACKAGED_APP" ] &&
  [ -z "$(/usr/bin/find "$EXTRACTED" -type l -print -quit)" ] &&
  [ -f "$PACKAGED_APP/Contents/Info.plist" ] && [ ! -L "$PACKAGED_APP/Contents/Info.plist" ] &&
  [ -x "$PACKAGED_APP/Contents/MacOS/runtime-raiders-agent" ] &&
  [ ! -L "$PACKAGED_APP/Contents/MacOS/runtime-raiders-agent" ] || {
  echo "release archive must contain exactly one Runtime Raiders Agent.app" >&2
  exit 1
}
validate_bundle_version "$PACKAGED_APP" || {
  echo "bundle version does not match companion/RELEASE" >&2
  exit 1
}
"$LIPO_TOOL" "$PACKAGED_APP/Contents/MacOS/runtime-raiders-agent" -verify_arch arm64 x86_64
"$CODESIGN_TOOL" --verify --deep --strict --verbose=2 "$PACKAGED_APP"
"$SPCTL_TOOL" --assess --type execute --verbose=2 "$PACKAGED_APP"
"$XCRUN_TOOL" stapler validate "$PACKAGED_APP"

VERSION_PLACEHOLDERS="$(/usr/bin/grep -o '__RUNTIME_RAIDERS_COMPANION_VERSION__' "$INSTALLER_TEMPLATE" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
TEAM_PLACEHOLDERS="$(/usr/bin/grep -o '__RUNTIME_RAIDERS_TEAM_ID__' "$INSTALLER_TEMPLATE" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
[ "$VERSION_PLACEHOLDERS" -eq 1 ] && [ "$TEAM_PLACEHOLDERS" -eq 1 ] || {
  echo "installer template placeholders are invalid" >&2
  exit 1
}
/usr/bin/sed \
  -e "s/__RUNTIME_RAIDERS_COMPANION_VERSION__/$COMPANION_VERSION/g" \
  -e "s/__RUNTIME_RAIDERS_TEAM_ID__/$RUNTIME_RAIDERS_TEAM_ID/g" \
  "$INSTALLER_TEMPLATE" > "$STAGED_OUTPUT/install.sh"
/bin/chmod 755 "$STAGED_OUTPUT/install.sh"
if /usr/bin/grep -F '__RUNTIME_RAIDERS_' "$STAGED_OUTPUT/install.sh" >/dev/null; then
  echo "unrendered installer placeholder" >&2
  exit 1
fi
/usr/bin/grep -F -x "COMPANION_VERSION='$COMPANION_VERSION'" "$STAGED_OUTPUT/install.sh" >/dev/null &&
  /usr/bin/grep -F -x "TEAM_ID='$RUNTIME_RAIDERS_TEAM_ID'" "$STAGED_OUTPUT/install.sh" >/dev/null || {
  echo "rendered installer version or Team ID is invalid" >&2
  exit 1
}

printf '{"version":"%s"}\n' "$COMPANION_VERSION" > "$STAGED_OUTPUT/version"

file_bytes() {
  /usr/bin/wc -c < "$1" | /usr/bin/tr -d ' '
}
file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk 'NR == 1 { print $1 }'
}
INSTALLER_BYTES="$(file_bytes "$STAGED_OUTPUT/install.sh")"
ARCHIVE_BYTES="$(file_bytes "$ARCHIVE")"
VERSION_BYTES="$(file_bytes "$STAGED_OUTPUT/version")"
INSTALLER_SHA256="$(file_sha256 "$STAGED_OUTPUT/install.sh")"
ARCHIVE_SHA256="$(file_sha256 "$ARCHIVE")"
VERSION_SHA256="$(file_sha256 "$STAGED_OUTPUT/version")"
cat > "$STAGED_OUTPUT/release-summary.txt" <<EOF
git_sha=$GIT_SHA
companion_version=$COMPANION_VERSION
bundle_identifier=com.redlattice.runtime-raiders-agent
team_id=$RUNTIME_RAIDERS_TEAM_ID
codesign_verified=true
hardened_runtime=true
secure_timestamp=true
notarization=Accepted
stapled=true
gatekeeper=accepted
archive_shape=one-app
install.sh_bytes=$INSTALLER_BYTES
install.sh_sha256=$INSTALLER_SHA256
runtime-raiders-agent.zip_bytes=$ARCHIVE_BYTES
runtime-raiders-agent.zip_sha256=$ARCHIVE_SHA256
version_bytes=$VERSION_BYTES
version_sha256=$VERSION_SHA256
EOF
/bin/chmod 644 "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$STAGED_OUTPUT/version" "$STAGED_OUTPUT/release-summary.txt"

[ "$(/usr/bin/find "$STAGED_OUTPUT" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || {
  echo "local release output must contain exactly four files" >&2
  exit 1
}
"$ROOT/scripts/test/verify-runtime-raiders-signed-release.sh" "$STAGED_OUTPUT"

FINAL_GIT_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || {
  echo "unable to recheck reviewed source" >&2
  exit 1
}
FINAL_GIT_SHA="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || {
  echo "unable to recheck reviewed source" >&2
  exit 1
}
[ -z "$FINAL_GIT_STATUS" ] && [ "$FINAL_GIT_SHA" = "$GIT_SHA" ] || {
  echo "reviewed source changed during release build" >&2
  exit 1
}

[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "release output appeared during build" >&2
  exit 1
}
/bin/mv "$STAGED_OUTPUT" "$OUTPUT"
STAGED_OUTPUT=''
echo "Built and verified local Runtime Raiders beta $COMPANION_VERSION at $OUTPUT."
