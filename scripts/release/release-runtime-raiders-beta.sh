#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0 prepare|publish" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
case "$1" in prepare|publish) MODE="$1" ;; *) usage ;; esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BUILDER="$ROOT/scripts/release/build-runtime-raiders-agent.sh"
VERIFIER="$ROOT/scripts/test/verify-runtime-raiders-signed-release.sh"
SSH_TOOL=/usr/bin/ssh
CURL_TOOL=/usr/bin/curl
PUBLISH_ROOT=/var/lib/runtime-raiders
BEFORE_TRANSMISSION_HOOK=''
DURING_TRANSMISSION_COPY_HOOK=''

unsafe_test_configuration() {
  echo "release test configuration is invalid" >&2
  exit 64
}

validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) unsafe_test_configuration ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || unsafe_test_configuration
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$(/usr/bin/id -u)" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || unsafe_test_configuration
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || unsafe_test_configuration
}

if [ -n "${RUNTIME_RAIDERS_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_TEST_MODE" = 1 ] &&
    [ "${RUNTIME_RAIDERS_TEST_ROOT:-}" = "$ROOT" ] || unsafe_test_configuration
  BUILDER="${RUNTIME_RAIDERS_TEST_BUILDER:-}"
  VERIFIER="${RUNTIME_RAIDERS_TEST_VERIFIER:-}"
  SSH_TOOL="${RUNTIME_RAIDERS_TEST_SSH:-}"
  CURL_TOOL="${RUNTIME_RAIDERS_TEST_CURL:-}"
  PUBLISH_ROOT="${RUNTIME_RAIDERS_TEST_PUBLISH_ROOT:-}"
  BEFORE_TRANSMISSION_HOOK="${RUNTIME_RAIDERS_TEST_BEFORE_TRANSMISSION:-}"
  DURING_TRANSMISSION_COPY_HOOK="${RUNTIME_RAIDERS_TEST_DURING_TRANSMISSION_COPY:-}"
  case "$PUBLISH_ROOT" in /*) ;; *) unsafe_test_configuration ;; esac
  [ -d "$PUBLISH_ROOT" ] && [ ! -L "$PUBLISH_ROOT" ] || unsafe_test_configuration
  for tool in "$BUILDER" "$VERIFIER" "$SSH_TOOL" "$CURL_TOOL"; do validate_test_tool "$tool"; done
  [ -z "$BEFORE_TRANSMISSION_HOOK" ] || validate_test_tool "$BEFORE_TRANSMISSION_HOOK"
  [ -z "$DURING_TRANSMISSION_COPY_HOOK" ] || validate_test_tool "$DURING_TRANSMISSION_COPY_HOOK"
else
  for injected_name in \
    RUNTIME_RAIDERS_TEST_ROOT RUNTIME_RAIDERS_TEST_BUILDER RUNTIME_RAIDERS_TEST_VERIFIER \
    RUNTIME_RAIDERS_TEST_SSH RUNTIME_RAIDERS_TEST_CURL RUNTIME_RAIDERS_TEST_PUBLISH_ROOT \
    RUNTIME_RAIDERS_TEST_BEFORE_TRANSMISSION RUNTIME_RAIDERS_TEST_DURING_TRANSMISSION_COPY; do
    [ -z "${!injected_name:-}" ] || unsafe_test_configuration
  done
fi

for tool in "$BUILDER" "$VERIFIER" "$SSH_TOOL" "$CURL_TOOL"; do
  [ -x "$tool" ] || {
    echo "required release tool is unavailable: $tool" >&2
    exit 69
  }
done

RELEASE_FILE="$ROOT/companion/RELEASE"
[ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ] || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}
VERSION_LINE="$(/usr/bin/sed -n '2p' "$RELEASE_FILE")"
case "$VERSION_LINE" in companion_version=*) VERSION="${VERSION_LINE#companion_version=}" ;; *) VERSION='' ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
  /usr/bin/cmp -s "$RELEASE_FILE" <(printf 'format=1\ncompanion_version=%s\n' "$VERSION") || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}

clean_head() {
  local status sha
  status="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || return 1
  [ -z "$status" ] || return 1
  sha="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || return 1
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}
GIT_SHA="$(clean_head)" || {
  echo "reviewed Git HEAD must be clean" >&2
  exit 1
}

OUTPUT="$ROOT/dist/runtime-raiders-beta-$VERSION"
if [ ! -e "$OUTPUT" ]; then
  /bin/bash "$BUILDER"
fi
[ -d "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "verified local release is missing: $OUTPUT" >&2
  exit 1
}

release_snapshot() {
  local directory="$1" name member mode owner
  owner="$(/usr/bin/id -u)"
  [ -d "$directory" ] && [ ! -L "$directory" ] &&
    [ "$(/usr/bin/stat -f '%u' "$directory")" = "$owner" ] || return 1
  mode="$(/usr/bin/stat -f '%Lp' "$directory")"
  (( (8#$mode & 8#022) == 0 )) || return 1
  [ "$(/usr/bin/find "$directory" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || return 1
  for name in install.sh runtime-raiders-agent.zip version release-summary.txt; do
    member="$directory/$name"
    [ -f "$member" ] && [ ! -L "$member" ] &&
      [ "$(/usr/bin/stat -f '%u' "$member")" = "$owner" ] &&
      [ "$(/usr/bin/stat -f '%l' "$member")" = 1 ] || return 1
    mode="$(/usr/bin/stat -f '%Lp' "$member")"
    (( (8#$mode & 8#022) == 0 )) || return 1
    printf '%s:%s:' "$name" "$(/usr/bin/stat -f '%u:%g:%l:%Lp:%d:%i:%z:%m:%c' "$member")"
    /usr/bin/shasum -a 256 "$member" | /usr/bin/awk 'NR == 1 { print $1 }'
  done
}
snapshot_hash() {
  local snapshot="$1" name="$2" value
  value="$(printf '%s\n' "$snapshot" | /usr/bin/awk -F: -v name="$name" '$1 == name { count += 1; value = $NF } END { if (count == 1) print value; else exit 1 }')" || return 1
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$value"
}
file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk 'NR == 1 { print $1 }'
}
OUTPUT_BEFORE_VERIFY="$(release_snapshot "$OUTPUT")" || {
  echo "local release output is unsafe" >&2
  exit 1
}
/bin/bash "$VERIFIER" "$OUTPUT"
OUTPUT_AFTER_VERIFY="$(release_snapshot "$OUTPUT")" || {
  echo "local release changed during local verification" >&2
  exit 1
}
[ "$OUTPUT_AFTER_VERIFY" = "$OUTPUT_BEFORE_VERIFY" ] || {
  echo "local release changed during local verification" >&2
  exit 1
}
[ -x "$OUTPUT/install.sh" ] && [ -s "$OUTPUT/runtime-raiders-agent.zip" ] &&
  [ -f "$OUTPUT/release-summary.txt" ] && [ ! -L "$OUTPUT/release-summary.txt" ] &&
  /usr/bin/cmp -s "$OUTPUT/version" <(printf '{"version":"%s"}\n' "$VERSION") || {
  echo "local release files do not match companion/RELEASE" >&2
  exit 1
}
[ "$(clean_head)" = "$GIT_SHA" ] || {
  echo "reviewed source changed during local verification" >&2
  exit 1
}

if [ "$MODE" = prepare ]; then
  echo "Prepared Runtime Raiders $VERSION locally."
  echo "Nothing was published or installed."
  echo "To publish after approval, run:"
  echo "/bin/bash scripts/release/release-runtime-raiders-beta.sh publish"
  exit 0
fi

PUBLISH_WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-publish.XXXXXX")"
cleanup_publish() {
  local status=$?
  trap - EXIT HUP INT TERM
  /bin/rm -rf -- "$PUBLISH_WORK" || status=1
  exit "$status"
}
trap cleanup_publish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
PUBLISH_RELEASE="$PUBLISH_WORK/release"
/bin/mkdir -m 0700 "$PUBLISH_RELEASE"
for name in install.sh runtime-raiders-agent.zip version release-summary.txt; do
  /bin/cp "$OUTPUT/$name" "$PUBLISH_RELEASE/$name"
done
/bin/chmod 0700 "$PUBLISH_RELEASE/install.sh"
/bin/chmod 0600 "$PUBLISH_RELEASE/runtime-raiders-agent.zip" "$PUBLISH_RELEASE/version" "$PUBLISH_RELEASE/release-summary.txt"
OUTPUT_AFTER_COPY="$(release_snapshot "$OUTPUT")" || {
  echo "local release changed while making the publication copy" >&2
  exit 1
}
[ "$OUTPUT_AFTER_COPY" = "$OUTPUT_AFTER_VERIFY" ] || {
  echo "local release changed while making the publication copy" >&2
  exit 1
}
PRIVATE_BEFORE_VERIFY="$(release_snapshot "$PUBLISH_RELEASE")" || {
  echo "private publication copy is unsafe" >&2
  exit 1
}
/bin/bash "$VERIFIER" "$PUBLISH_RELEASE"
PRIVATE_AFTER_VERIFY="$(release_snapshot "$PUBLISH_RELEASE")" || {
  echo "private publication copy changed during verification" >&2
  exit 1
}
[ "$PRIVATE_AFTER_VERIFY" = "$PRIVATE_BEFORE_VERIFY" ] || {
  echo "private publication copy changed during verification" >&2
  exit 1
}
APPROVED_INSTALLER_SHA="$(snapshot_hash "$PRIVATE_AFTER_VERIFY" install.sh)" || exit 1
APPROVED_ARCHIVE_SHA="$(snapshot_hash "$PRIVATE_AFTER_VERIFY" runtime-raiders-agent.zip)" || exit 1
APPROVED_VERSION_SHA="$(snapshot_hash "$PRIVATE_AFTER_VERIFY" version)" || exit 1
[ "$(clean_head)" = "$GIT_SHA" ] || {
  echo "reviewed source changed while sealing publication input" >&2
  exit 1
}

[ -z "$BEFORE_TRANSMISSION_HOOK" ] || "$BEFORE_TRANSMISSION_HOOK" "$PUBLISH_RELEASE"
PRIVATE_BEFORE_TRANSMISSION="$(release_snapshot "$PUBLISH_RELEASE")" || {
  echo "private release changed before transmission was sealed" >&2
  exit 1
}
[ "$PRIVATE_BEFORE_TRANSMISSION" = "$PRIVATE_AFTER_VERIFY" ] || {
  echo "private release changed before transmission was sealed" >&2
  exit 1
}

TRANSMISSION_DIR="$PUBLISH_WORK/transmission"
/bin/mkdir -m 0700 "$TRANSMISSION_DIR"
for name in install.sh runtime-raiders-agent.zip version; do
  [ -z "$DURING_TRANSMISSION_COPY_HOOK" ] || "$DURING_TRANSMISSION_COPY_HOOK" "$name" "$PUBLISH_RELEASE"
  /bin/cp "$PUBLISH_RELEASE/$name" "$TRANSMISSION_DIR/$name"
done
/bin/chmod 0700 "$TRANSMISSION_DIR/install.sh"
/bin/chmod 0600 "$TRANSMISSION_DIR/runtime-raiders-agent.zip" "$TRANSMISSION_DIR/version"
cat > "$TRANSMISSION_DIR/expected-sha256" <<EOF
install.sh=$APPROVED_INSTALLER_SHA
runtime-raiders-agent.zip=$APPROVED_ARCHIVE_SHA
version=$APPROVED_VERSION_SHA
EOF
/bin/chmod 0600 "$TRANSMISSION_DIR/expected-sha256"
PRIVATE_AFTER_TRANSMISSION_COPY="$(release_snapshot "$PUBLISH_RELEASE")" || {
  echo "private release changed while sealing transmission" >&2
  exit 1
}
[ "$PRIVATE_AFTER_TRANSMISSION_COPY" = "$PRIVATE_AFTER_VERIFY" ] || {
  echo "private release changed while sealing transmission" >&2
  exit 1
}
for name in install.sh runtime-raiders-agent.zip version; do
  /usr/bin/cmp -s "$TRANSMISSION_DIR/$name" "$PUBLISH_RELEASE/$name" || {
    echo "transmission input does not match the approved release" >&2
    exit 1
  }
done
[ "$(file_sha256 "$TRANSMISSION_DIR/install.sh")" = "$APPROVED_INSTALLER_SHA" ] &&
  [ "$(file_sha256 "$TRANSMISSION_DIR/runtime-raiders-agent.zip")" = "$APPROVED_ARCHIVE_SHA" ] &&
  [ "$(file_sha256 "$TRANSMISSION_DIR/version")" = "$APPROVED_VERSION_SHA" ] || {
  echo "transmission files do not match the verifier-approved release" >&2
  exit 1
}

TRANSMISSION_TAR="$PUBLISH_WORK/transmission.tar"
/usr/bin/tar -cf "$TRANSMISSION_TAR" -C "$TRANSMISSION_DIR" \
  install.sh runtime-raiders-agent.zip version expected-sha256
TRANSMISSION_CHECK="$PUBLISH_WORK/transmission-check"
/bin/mkdir -m 0700 "$TRANSMISSION_CHECK"
/usr/bin/tar -tf "$TRANSMISSION_TAR" > "$PUBLISH_WORK/transmission-members"
/usr/bin/cmp -s "$PUBLISH_WORK/transmission-members" \
  <(printf 'install.sh\nruntime-raiders-agent.zip\nversion\nexpected-sha256\n') || {
  echo "sealed transmission member set is invalid" >&2
  exit 1
}
/usr/bin/tar --no-same-owner -xf "$TRANSMISSION_TAR" -C "$TRANSMISSION_CHECK"
for name in install.sh runtime-raiders-agent.zip version expected-sha256; do
  /usr/bin/cmp -s "$TRANSMISSION_CHECK/$name" "$TRANSMISSION_DIR/$name" || {
    echo "sealed transmission bytes are invalid" >&2
    exit 1
  }
done
/bin/chmod 0400 "$TRANSMISSION_TAR"
TRANSMISSION_SNAPSHOT="$(/usr/bin/stat -f '%u:%l:%Lp:%d:%i:%z:%m:%c' "$TRANSMISSION_TAR"):$(file_sha256 "$TRANSMISSION_TAR")"

RELEASE_USER="${RUNTIME_RAIDERS_RELEASE_USER:-rluser}"
[[ "$RELEASE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  echo "RUNTIME_RAIDERS_RELEASE_USER is invalid" >&2
  exit 64
}
RELEASE_HOST="${RUNTIME_RAIDERS_RELEASE_HOST:-$RELEASE_USER@raiders.local}"
[[ "$RELEASE_HOST" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || {
  echo "RUNTIME_RAIDERS_RELEASE_HOST is invalid" >&2
  exit 64
}
[ "${RELEASE_HOST%%@*}" = "$RELEASE_USER" ] || {
  echo "RUNTIME_RAIDERS_RELEASE_HOST user must match RUNTIME_RAIDERS_RELEASE_USER" >&2
  exit 64
}
RELEASE_ID="$(/usr/bin/uuidgen | /usr/bin/tr -d '-' | /usr/bin/tr 'A-F' 'a-f')"
[[ "$RELEASE_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "could not create a publication ID" >&2
  exit 1
}
REMOTE_STAGE="$PUBLISH_ROOT/staging/release-$RELEASE_ID"
case "$ROOT$PUBLISH_ROOT" in *[!A-Za-z0-9_./-]*) unsafe_test_configuration ;; esac
[ "$(/usr/bin/stat -f '%u:%l:%Lp:%d:%i:%z:%m:%c' "$TRANSMISSION_TAR"):$(file_sha256 "$TRANSMISSION_TAR")" = "$TRANSMISSION_SNAPSHOT" ] || {
  echo "sealed transmission changed before SSH" >&2
  exit 1
}
"$SSH_TOOL" "$RELEASE_HOST" /usr/bin/sudo -n \
  /usr/local/sbin/runtime-raiders-publish "$REMOTE_STAGE" < "$TRANSMISSION_TAR"

VERIFY_WORK="$PUBLISH_WORK/public-verification"
/bin/mkdir -m 0700 "$VERIFY_WORK"

header_has_exact_value() {
  local file="$1" header="$2" expected="$3"
  /usr/bin/awk -v header="$header" -v expected="$expected" '
    BEGIN { target = tolower(header) }
    { sub(/\r$/, "") }
    /^HTTP\/[0-9.]+[[:space:]][0-9][0-9][0-9]([[:space:]]|$)/ {
      blocks += 1; count = 0; found = ""; in_headers = 1; next
    }
    in_headers && $0 == "" { in_headers = 0; next }
    in_headers && index($0, ":") > 0 {
      name = substr($0, 1, index($0, ":") - 1)
      value = substr($0, index($0, ":") + 1)
      sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value)
      if (tolower(name) == target) { count += 1; found = value }
    }
    END { exit !(blocks > 0 && count == 1 && found == expected) }
  ' "$file"
}
verify_release_headers() {
  local file="$1" content_type="$2"
  header_has_exact_value "$file" Content-Type "$content_type" &&
    header_has_exact_value "$file" Cache-Control no-store &&
    header_has_exact_value "$file" X-Content-Type-Options nosniff
}

PUBLIC_BASE=https://raiders.redlattice.com
"$CURL_TOOL" -fsS -D "$VERIFY_WORK/install.headers" -o "$VERIFY_WORK/install.sh" "$PUBLIC_BASE/install.sh"
/usr/bin/cmp -s "$VERIFY_WORK/install.sh" "$PUBLISH_RELEASE/install.sh" || { echo "public install.sh mismatch" >&2; exit 1; }
verify_release_headers "$VERIFY_WORK/install.headers" 'text/x-shellscript; charset=utf-8' || { echo "public release headers are invalid: install.sh" >&2; exit 1; }
"$CURL_TOOL" -fsS -D "$VERIFY_WORK/archive.headers" -o "$VERIFY_WORK/runtime-raiders-agent.zip" "$PUBLIC_BASE/downloads/runtime-raiders-agent.zip"
/usr/bin/cmp -s "$VERIFY_WORK/runtime-raiders-agent.zip" "$PUBLISH_RELEASE/runtime-raiders-agent.zip" || { echo "public archive mismatch" >&2; exit 1; }
verify_release_headers "$VERIFY_WORK/archive.headers" 'application/zip' || { echo "public release headers are invalid: archive" >&2; exit 1; }
"$CURL_TOOL" -fsS -D "$VERIFY_WORK/version.headers" -o "$VERIFY_WORK/version" "$PUBLIC_BASE/version"
/usr/bin/cmp -s "$VERIFY_WORK/version" "$PUBLISH_RELEASE/version" || { echo "public version mismatch" >&2; exit 1; }
verify_release_headers "$VERIFY_WORK/version.headers" 'application/json; charset=utf-8' || { echo "public release headers are invalid: version" >&2; exit 1; }
"$CURL_TOOL" -fsS "$PUBLIC_BASE/health" > "$VERIFY_WORK/health"
/usr/bin/cmp -s "$VERIFY_WORK/health" <(printf '{"ok":true}') || { echo "public health check failed" >&2; exit 1; }

echo "Runtime Raiders $VERSION published."
echo "Git SHA: $GIT_SHA"
echo "$PUBLIC_BASE/install.sh"
echo "$PUBLIC_BASE/downloads/runtime-raiders-agent.zip"
echo "$PUBLIC_BASE/version"
echo "Employee collection remains off."
