#!/bin/sh

set -eu

if [ "$#" -ne 8 ]; then
  echo "usage: $0 template validator team-id version sequence release-sha protocol output" >&2
  exit 64
fi

TEMPLATE="$1"
VALIDATOR="$2"
TEAM_ID="$3"
VERSION="$4"
SEQUENCE="$5"
RELEASE_SHA="$6"
PROTOCOL="$7"
OUTPUT="$8"

[ -f "$TEMPLATE" ] && [ ! -L "$TEMPLATE" ] || exit 64
[ -f "$VALIDATOR" ] && [ ! -L "$VALIDATOR" ] || exit 64
case "$TEAM_ID" in ''|*[!A-Z0-9]*) exit 64 ;; esac
[ "$(printf '%s' "$TEAM_ID" | wc -c | tr -d ' ')" -eq 10 ] || exit 64
case "$VERSION" in ''|*[!A-Za-z0-9._+-]*) exit 64 ;; esac
[ "$(printf '%s' "$VERSION" | wc -c | tr -d ' ')" -le 100 ] || exit 64
case "$SEQUENCE" in ''|0|0*|*[!0-9]*) exit 64 ;; esac
[ "$(printf '%s' "$SEQUENCE" | wc -c | tr -d ' ')" -le 16 ] &&
  [ "$SEQUENCE" -le 9007199254740991 ] || exit 64
case "$RELEASE_SHA" in *[!0-9a-f]*) exit 64 ;; esac
[ "$(printf '%s' "$RELEASE_SHA" | wc -c | tr -d ' ')" -eq 40 ] || exit 64
[ "$PROTOCOL" = 2 ] || exit 64

OUTPUT_PARENT="$(dirname "$OUTPUT")"
[ -d "$OUTPUT_PARENT" ] && [ ! -L "$OUTPUT_PARENT" ] || exit 64
OUTPUT_PARENT="$(CDPATH= cd -- "$OUTPUT_PARENT" && pwd -P)"
OUTPUT="$OUTPUT_PARENT/$(basename "$OUTPUT")"
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || exit 1

VALIDATOR_SHA256="$(/usr/bin/shasum -a 256 "$VALIDATOR" | awk 'NR == 1 { print $1 }')"
case "$VALIDATOR_SHA256" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "${#VALIDATOR_SHA256}" -eq 64 ] || exit 1

TEMPORARY="$(mktemp "$OUTPUT_PARENT/.runtime-raiders-installer-render.XXXXXX")"
cleanup() {
  status=$?
  rm -f "$TEMPORARY"
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

sed \
  -e "s/__RUNTIME_RAIDERS_TEAM_ID__/$TEAM_ID/g" \
  -e "s/__RUNTIME_RAIDERS_COMPANION_VERSION__/$VERSION/g" \
  -e "s/__RUNTIME_RAIDERS_RELEASE_SEQUENCE__/$SEQUENCE/g" \
  -e "s/__RUNTIME_RAIDERS_RELEASE_SHA__/$RELEASE_SHA/g" \
  -e "s/__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__/$PROTOCOL/g" \
  -e "s/__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__/$VALIDATOR_SHA256/g" \
  "$TEMPLATE" | while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "RELEASE_VALIDATOR_BASE64='__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__'" ]; then
      printf "RELEASE_VALIDATOR_BASE64='"
      /usr/bin/base64 < "$VALIDATOR" | /usr/bin/tr -d '\n'
      printf "'\n"
    else
      printf '%s\n' "$line"
    fi
  done > "$TEMPORARY"

grep -F '__RUNTIME_RAIDERS_' "$TEMPORARY" >/dev/null && exit 1
chmod 755 "$TEMPORARY"
mv "$TEMPORARY" "$OUTPUT"
