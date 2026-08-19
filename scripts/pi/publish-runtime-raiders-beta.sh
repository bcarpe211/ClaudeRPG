#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0 /var/lib/runtime-raiders/staging/release-ID < transmission.tar" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage

OWNER=0
PUBLISH_ROOT=/var/lib/runtime-raiders
MV_TOOL=/bin/mv
TRANSMISSION_MAX_BYTES=9437184

file_uid() { /usr/bin/stat -c '%u' "$1" 2>/dev/null || /usr/bin/stat -f '%u' "$1"; }
file_links() { /usr/bin/stat -c '%h' "$1" 2>/dev/null || /usr/bin/stat -f '%l' "$1"; }
file_mode() { /usr/bin/stat -c '%a' "$1" 2>/dev/null || /usr/bin/stat -f '%Lp' "$1"; }
hash_file() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/sha256sum "$1" | /usr/bin/awk 'NR == 1 { print $1 }'
  else
    /usr/bin/shasum -a 256 "$1" | /usr/bin/awk 'NR == 1 { print $1 }'
  fi
}
safe_mode() {
  local mode
  mode="$(file_mode "$1")"
  (( (8#$mode & 8#077) == 0 ))
}

unsafe_test_configuration() {
  echo "publisher test configuration is invalid" >&2
  exit 64
}

if [ -n "${RUNTIME_RAIDERS_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_TEST_MODE" = 1 ] || unsafe_test_configuration
  TEST_ROOT="${RUNTIME_RAIDERS_TEST_ROOT:-}"
  PUBLISH_ROOT="${RUNTIME_RAIDERS_TEST_PUBLISH_ROOT:-}"
  case "$TEST_ROOT" in /*) ;; *) unsafe_test_configuration ;; esac
  case "$PUBLISH_ROOT" in /*) ;; *) unsafe_test_configuration ;; esac
  [ -d "$TEST_ROOT" ] && [ ! -L "$TEST_ROOT" ] &&
    [ -d "$PUBLISH_ROOT" ] && [ ! -L "$PUBLISH_ROOT" ] || unsafe_test_configuration
  OWNER="$(/usr/bin/id -u)"
  if [ -n "${RUNTIME_RAIDERS_TEST_MV:-}" ]; then
    MV_TOOL="$RUNTIME_RAIDERS_TEST_MV"
    case "$MV_TOOL" in /*) ;; *) unsafe_test_configuration ;; esac
    [ -f "$MV_TOOL" ] && [ ! -L "$MV_TOOL" ] && [ -x "$MV_TOOL" ] &&
      [ "$(file_uid "$MV_TOOL")" = "$OWNER" ] && [ "$(file_links "$MV_TOOL")" = 1 ] || unsafe_test_configuration
    test_mv_mode="$(file_mode "$MV_TOOL")"
    (( (8#$test_mv_mode & 8#022) == 0 )) || unsafe_test_configuration
  fi
else
  for injected_name in RUNTIME_RAIDERS_TEST_ROOT RUNTIME_RAIDERS_TEST_PUBLISH_ROOT RUNTIME_RAIDERS_TEST_MV; do
    [ -z "${!injected_name:-}" ] || unsafe_test_configuration
  done
  [ "$(/usr/bin/id -u)" -eq 0 ] || {
    echo "publisher must run as root" >&2
    exit 77
  }
fi

STAGING_ROOT="$PUBLISH_ROOT/staging"
PUBLIC_ROOT="$PUBLISH_ROOT/public"
REQUESTED_STAGE="$1"
case "$REQUESTED_STAGE" in "$STAGING_ROOT"/release-[0-9A-Fa-f]*) ;; *) usage ;; esac
STAGE_NAME="${REQUESTED_STAGE##*/}"
[[ "$STAGE_NAME" =~ ^release-[0-9A-Fa-f]{16,}$ ]] || usage
[ -d "$STAGING_ROOT" ] && [ ! -L "$STAGING_ROOT" ] &&
  [ "$(file_uid "$STAGING_ROOT")" = "$OWNER" ] && safe_mode "$STAGING_ROOT" || {
  echo "staging root is unsafe or bootstrap is missing" >&2
  exit 1
}
STAGE_PARENT="$(cd "${REQUESTED_STAGE%/*}" && pwd -P)"
[ "$STAGE_PARENT" = "$STAGING_ROOT" ] || usage
[ ! -e "$REQUESTED_STAGE" ] && [ ! -L "$REQUESTED_STAGE" ] || {
  echo "remote staging must be initially absent" >&2
  exit 1
}

STAGE="$REQUESTED_STAGE"
TRANSMISSION=''
ARCHIVE_TEMP=''
INSTALLER_TEMP=''
VERSION_TEMP=''
MEMBER_LIST=''
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  for temporary in "$TRANSMISSION" "$MEMBER_LIST" "$ARCHIVE_TEMP" "$INSTALLER_TEMP" "$VERSION_TEMP"; do
    [ -z "$temporary" ] || /bin/rm -f -- "$temporary" || status=1
  done
  if [ -d "$STAGE" ] && [ ! -L "$STAGE" ]; then
    /bin/rm -rf -- "$STAGE" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/bin/mkdir -m 0700 "$STAGE"
[ "$(file_uid "$STAGE")" = "$OWNER" ] && safe_mode "$STAGE" || {
  echo "could not create private staging" >&2
  exit 1
}
TRANSMISSION="$(/usr/bin/mktemp "$STAGING_ROOT/.transmission.XXXXXX")"
/usr/bin/head -c "$((TRANSMISSION_MAX_BYTES + 1))" > "$TRANSMISSION"
TRANSMISSION_BYTES="$(/usr/bin/wc -c < "$TRANSMISSION" | /usr/bin/tr -d ' ')"
[ "$TRANSMISSION_BYTES" -gt 0 ] && [ "$TRANSMISSION_BYTES" -le "$TRANSMISSION_MAX_BYTES" ] || {
  echo "transmission is empty or too large" >&2
  exit 1
}

MEMBER_LIST="$(/usr/bin/mktemp "$STAGING_ROOT/.members.XXXXXX")"
/usr/bin/tar -tf "$TRANSMISSION" > "$MEMBER_LIST"
/usr/bin/cmp -s "$MEMBER_LIST" <(printf 'install.sh\nruntime-raiders-agent.zip\nversion\nexpected-sha256\n') || {
  /bin/rm -f -- "$MEMBER_LIST"
  echo "transmission must contain exactly four fixed members" >&2
  exit 1
}
/bin/rm -f -- "$MEMBER_LIST"
MEMBER_LIST=''
/usr/bin/tar --no-same-owner -xf "$TRANSMISSION" -C "$STAGE"
/bin/rm -f -- "$TRANSMISSION"
TRANSMISSION=''

[ "$(/usr/bin/find "$STAGE" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || {
  echo "staging must contain exactly three public files and expected hashes" >&2
  exit 1
}
for name in install.sh runtime-raiders-agent.zip version expected-sha256; do
  member="$STAGE/$name"
  [ -f "$member" ] && [ ! -L "$member" ] && [ "$(file_uid "$member")" = "$OWNER" ] &&
    [ "$(file_links "$member")" = 1 ] && safe_mode "$member" || {
    echo "unsafe staging member: $name" >&2
    exit 1
  }
done

expected_hash() {
  local name="$1"
  /usr/bin/awk -F= -v name="$name" '$1 == name && NF == 2 { count += 1; value = $2 } END { if (count == 1) print value; else exit 1 }' "$STAGE/expected-sha256"
}
[ "$(/usr/bin/wc -l < "$STAGE/expected-sha256" | /usr/bin/tr -d ' ')" -eq 3 ] || {
  echo "expected hashes are invalid" >&2
  exit 1
}
for name in install.sh runtime-raiders-agent.zip version; do
  expected="$(expected_hash "$name")" || { echo "expected hashes are invalid" >&2; exit 1; }
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] && [ "$(hash_file "$STAGE/$name")" = "$expected" ] || {
    echo "transmission hash mismatch: $name" >&2
    exit 1
  }
done

[ -x "$STAGE/install.sh" ] && /bin/sh -n "$STAGE/install.sh" || { echo "install.sh is invalid" >&2; exit 1; }
[ -s "$STAGE/runtime-raiders-agent.zip" ] || { echo "runtime-raiders-agent.zip is empty" >&2; exit 1; }
VERSION="$(/usr/bin/sed -n 's/^{"version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"}$/\1/p' "$STAGE/version")"
[ -n "$VERSION" ] && /usr/bin/cmp -s "$STAGE/version" <(printf '{"version":"%s"}\n' "$VERSION") || {
  echo "version is invalid" >&2
  exit 1
}

/usr/bin/install -d -m 0755 -o "$OWNER" "$PUBLIC_ROOT"
[ -d "$PUBLIC_ROOT" ] && [ ! -L "$PUBLIC_ROOT" ] && [ "$(file_uid "$PUBLIC_ROOT")" = "$OWNER" ] || {
  echo "public directory is unsafe" >&2
  exit 1
}
public_mode="$(file_mode "$PUBLIC_ROOT")"
(( (8#$public_mode & 8#022) == 0 )) || { echo "public directory is writable by another user" >&2; exit 1; }
for name in runtime-raiders-agent.zip install.sh version; do
  target="$PUBLIC_ROOT/$name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] && [ "$(file_uid "$target")" = "$OWNER" ] &&
      [ "$(file_links "$target")" = 1 ] || { echo "existing public target is unsafe: $name" >&2; exit 1; }
  fi
done

ARCHIVE_TEMP="$(/usr/bin/mktemp "$PUBLIC_ROOT/.runtime-raiders-agent.zip.XXXXXX")"
INSTALLER_TEMP="$(/usr/bin/mktemp "$PUBLIC_ROOT/.install.sh.XXXXXX")"
VERSION_TEMP="$(/usr/bin/mktemp "$PUBLIC_ROOT/.version.XXXXXX")"
/usr/bin/install -m 0644 "$STAGE/runtime-raiders-agent.zip" "$ARCHIVE_TEMP"
/usr/bin/install -m 0755 "$STAGE/install.sh" "$INSTALLER_TEMP"
/usr/bin/install -m 0644 "$STAGE/version" "$VERSION_TEMP"

"$MV_TOOL" -f -- "$ARCHIVE_TEMP" "$PUBLIC_ROOT/runtime-raiders-agent.zip"
ARCHIVE_TEMP=''
"$MV_TOOL" -f -- "$INSTALLER_TEMP" "$PUBLIC_ROOT/install.sh"
INSTALLER_TEMP=''
"$MV_TOOL" -f -- "$VERSION_TEMP" "$PUBLIC_ROOT/version"
VERSION_TEMP=''

echo "Published Runtime Raiders $VERSION public files."
