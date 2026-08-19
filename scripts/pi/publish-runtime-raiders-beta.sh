#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0 /var/lib/runtime-raiders/staging/release-ID" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage

OWNER=0
PUBLISH_ROOT=/var/lib/runtime-raiders
MV_TOOL=/bin/mv

file_uid() {
  /usr/bin/stat -c '%u' "$1" 2>/dev/null || /usr/bin/stat -f '%u' "$1"
}
file_links() {
  /usr/bin/stat -c '%h' "$1" 2>/dev/null || /usr/bin/stat -f '%l' "$1"
}
file_mode() {
  /usr/bin/stat -c '%a' "$1" 2>/dev/null || /usr/bin/stat -f '%Lp' "$1"
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
      [ "$(file_uid "$MV_TOOL")" = "$OWNER" ] &&
      [ "$(file_links "$MV_TOOL")" = 1 ] || unsafe_test_configuration
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
[ -d "$REQUESTED_STAGE" ] && [ ! -L "$REQUESTED_STAGE" ] || usage
STAGE_PARENT="$(cd "$REQUESTED_STAGE/.." && pwd -P)"
STAGE_NAME="${REQUESTED_STAGE##*/}"
STAGE="$(cd "$REQUESTED_STAGE" && pwd -P)"
[ "$STAGE_PARENT" = "$STAGING_ROOT" ] && [ "$STAGE" = "$STAGING_ROOT/$STAGE_NAME" ] || usage
[[ "$STAGE_NAME" =~ ^release-[0-9A-Fa-f]{16,}$ ]] || usage

safe_mode() {
  local mode
  mode="$(file_mode "$1")"
  (( (8#$mode & 8#077) == 0 ))
}

[ "$(file_uid "$STAGE")" = "$OWNER" ] && safe_mode "$STAGE" || {
  echo "staging directory must be owner-only" >&2
  exit 1
}
[ "$(/usr/bin/find "$STAGE" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 3 ] || {
  echo "staging must contain exactly three public files" >&2
  exit 1
}

for name in install.sh runtime-raiders-agent.zip version; do
  member="$STAGE/$name"
  [ -f "$member" ] && [ ! -L "$member" ] &&
    [ "$(file_uid "$member")" = "$OWNER" ] &&
    [ "$(file_links "$member")" = 1 ] && safe_mode "$member" || {
    echo "unsafe staging member: $name" >&2
    exit 1
  }
done
[ -x "$STAGE/install.sh" ] && /bin/sh -n "$STAGE/install.sh" || {
  echo "install.sh is invalid" >&2
  exit 1
}
[ -s "$STAGE/runtime-raiders-agent.zip" ] || {
  echo "runtime-raiders-agent.zip is empty" >&2
  exit 1
}
VERSION="$(/usr/bin/sed -n 's/^{"version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"}$/\1/p' "$STAGE/version")"
[ -n "$VERSION" ] && /usr/bin/cmp -s "$STAGE/version" <(printf '{"version":"%s"}\n' "$VERSION") || {
  echo "version is invalid" >&2
  exit 1
}

CLEAN_STAGE=1
ARCHIVE_TEMP=''
INSTALLER_TEMP=''
VERSION_TEMP=''
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  for temporary in "$ARCHIVE_TEMP" "$INSTALLER_TEMP" "$VERSION_TEMP"; do
    [ -z "$temporary" ] || /bin/rm -f -- "$temporary" || status=1
  done
  if [ "${CLEAN_STAGE:-0}" = 1 ]; then
    /bin/rm -rf -- "$STAGE" || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/install -d -m 0755 -o "$OWNER" "$PUBLIC_ROOT"
[ -d "$PUBLIC_ROOT" ] && [ ! -L "$PUBLIC_ROOT" ] &&
  [ "$(file_uid "$PUBLIC_ROOT")" = "$OWNER" ] || {
  echo "public directory is unsafe" >&2
  exit 1
}
public_mode="$(file_mode "$PUBLIC_ROOT")"
(( (8#$public_mode & 8#022) == 0 )) || {
  echo "public directory is writable by another user" >&2
  exit 1
}
for name in runtime-raiders-agent.zip install.sh version; do
  target="$PUBLIC_ROOT/$name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] &&
      [ "$(file_uid "$target")" = "$OWNER" ] && [ "$(file_links "$target")" = 1 ] || {
      echo "existing public target is unsafe: $name" >&2
      exit 1
    }
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
