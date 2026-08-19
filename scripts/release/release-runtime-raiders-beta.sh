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
TEST_REMOTE_ENV=''

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
  case "$PUBLISH_ROOT" in /*) ;; *) unsafe_test_configuration ;; esac
  [ -d "$PUBLISH_ROOT" ] && [ ! -L "$PUBLISH_ROOT" ] || unsafe_test_configuration
  for tool in "$BUILDER" "$VERIFIER" "$SSH_TOOL" "$CURL_TOOL"; do validate_test_tool "$tool"; done
  TEST_REMOTE_ENV="export RUNTIME_RAIDERS_TEST_MODE=1 RUNTIME_RAIDERS_TEST_ROOT='$ROOT' RUNTIME_RAIDERS_TEST_PUBLISH_ROOT='$PUBLISH_ROOT'"
else
  for injected_name in \
    RUNTIME_RAIDERS_TEST_ROOT RUNTIME_RAIDERS_TEST_BUILDER RUNTIME_RAIDERS_TEST_VERIFIER \
    RUNTIME_RAIDERS_TEST_SSH RUNTIME_RAIDERS_TEST_CURL RUNTIME_RAIDERS_TEST_PUBLISH_ROOT; do
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
PUBLISHER_COPY="$PUBLISH_WORK/publish-runtime-raiders-beta.sh"
/usr/bin/git -C "$ROOT" show "$GIT_SHA:scripts/pi/publish-runtime-raiders-beta.sh" > "$PUBLISHER_COPY"
/bin/chmod 0700 "$PUBLISHER_COPY"
[ "$(clean_head)" = "$GIT_SHA" ] || {
  echo "reviewed source changed while sealing publication input" >&2
  exit 1
}

RELEASE_HOST="${RUNTIME_RAIDERS_RELEASE_HOST:-rluser@raiders.local}"
[[ "$RELEASE_HOST" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || {
  echo "RUNTIME_RAIDERS_RELEASE_HOST is invalid" >&2
  exit 64
}
RELEASE_ID="$(/usr/bin/uuidgen | /usr/bin/tr -d '-' | /usr/bin/tr 'A-F' 'a-f')"
[[ "$RELEASE_ID" =~ ^[0-9a-f]{32}$ ]] || {
  echo "could not create a publication ID" >&2
  exit 1
}
REMOTE_STAGE="$PUBLISH_ROOT/staging/release-$RELEASE_ID"
case "$ROOT$PUBLISH_ROOT" in *[!A-Za-z0-9_./-]*) unsafe_test_configuration ;; esac

encode_file() {
  /usr/bin/base64 < "$1"
}

{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  echo 'umask 077'
  [ -z "$TEST_REMOTE_ENV" ] || echo "$TEST_REMOTE_ENV"
  printf "publish_root='%s'\n" "$PUBLISH_ROOT"
  printf "stage='%s'\n" "$REMOTE_STAGE"
  echo '/usr/bin/install -d -m 0700 "$publish_root/staging"'
  echo '[ ! -e "$stage" ] && [ ! -L "$stage" ] || { echo "remote staging already exists" >&2; exit 1; }'
  echo '/bin/mkdir -m 0700 "$stage"'
  echo 'publisher="$(/usr/bin/mktemp "$publish_root/staging/.publisher.XXXXXX")"'
  echo "cleanup() { status=\$?; /bin/rm -f -- \"\$publisher\"; [ \$status -eq 0 ] || /bin/rm -rf -- \"\$stage\"; exit \$status; }"
  echo 'trap cleanup EXIT HUP INT TERM'
  echo 'decode() { if /usr/bin/base64 --help 2>&1 | /usr/bin/grep -q -- --decode; then /usr/bin/base64 --decode; else /usr/bin/base64 -D; fi; }'
  for name in install.sh runtime-raiders-agent.zip version; do
    printf "decode > \"\$stage/%s\" <<'RUNTIME_RAIDERS_%s'\n" "$name" "${name//[^A-Za-z0-9]/_}"
    encode_file "$PUBLISH_RELEASE/$name"
    printf 'RUNTIME_RAIDERS_%s\n' "${name//[^A-Za-z0-9]/_}"
  done
  echo '/bin/chmod 0700 "$stage/install.sh"'
  echo '/bin/chmod 0600 "$stage/runtime-raiders-agent.zip" "$stage/version"'
  echo "decode > \"\$publisher\" <<'RUNTIME_RAIDERS_PUBLISHER'"
  encode_file "$PUBLISHER_COPY"
  echo 'RUNTIME_RAIDERS_PUBLISHER'
  echo '/bin/chmod 0700 "$publisher"'
  echo '/bin/bash "$publisher" "$stage"'
} | "$SSH_TOOL" "$RELEASE_HOST" /usr/bin/sudo /bin/bash -s

VERIFY_WORK="$PUBLISH_WORK/public-verification"
/bin/mkdir -m 0700 "$VERIFY_WORK"

PUBLIC_BASE=https://raiders.redlattice.com
"$CURL_TOOL" -fsS "$PUBLIC_BASE/install.sh" > "$VERIFY_WORK/install.sh"
/usr/bin/cmp -s "$VERIFY_WORK/install.sh" "$PUBLISH_RELEASE/install.sh" || { echo "public install.sh mismatch" >&2; exit 1; }
"$CURL_TOOL" -fsS -o "$VERIFY_WORK/runtime-raiders-agent.zip" "$PUBLIC_BASE/downloads/runtime-raiders-agent.zip"
/usr/bin/cmp -s "$VERIFY_WORK/runtime-raiders-agent.zip" "$PUBLISH_RELEASE/runtime-raiders-agent.zip" || { echo "public archive mismatch" >&2; exit 1; }
"$CURL_TOOL" -fsS "$PUBLIC_BASE/version" > "$VERIFY_WORK/version"
/usr/bin/cmp -s "$VERIFY_WORK/version" "$PUBLISH_RELEASE/version" || { echo "public version mismatch" >&2; exit 1; }
"$CURL_TOOL" -fsS "$PUBLIC_BASE/health" > "$VERIFY_WORK/health"
/usr/bin/cmp -s "$VERIFY_WORK/health" <(printf '{"ok":true}\n') || { echo "public health check failed" >&2; exit 1; }

echo "Runtime Raiders $VERSION published."
echo "Git SHA: $GIT_SHA"
echo "$PUBLIC_BASE/install.sh"
echo "$PUBLIC_BASE/downloads/runtime-raiders-agent.zip"
echo "$PUBLIC_BASE/version"
echo "Employee collection remains off."
