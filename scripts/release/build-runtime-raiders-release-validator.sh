#!/bin/bash

set -euo pipefail

[ "$#" -eq 3 ] || {
  echo "usage: $0 package-directory scratch-directory output" >&2
  exit 64
}

PACKAGE="$1"
SCRATCH="$2"
OUTPUT="$3"
[ -d "$PACKAGE" ] && [ ! -L "$PACKAGE" ] || exit 64
PACKAGE="$(cd "$PACKAGE" && pwd -P)"
case "$SCRATCH:$OUTPUT" in *$'\n'*) exit 64 ;; esac
case "$SCRATCH" in /*) ;; *) exit 64 ;; esac
case "$OUTPUT" in /*) ;; *) exit 64 ;; esac
[ ! -e "$SCRATCH" ] && [ ! -L "$SCRATCH" ] || exit 64
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || exit 64
OUTPUT_PARENT="$(dirname "$OUTPUT")"
[ -d "$OUTPUT_PARENT" ] && [ ! -L "$OUTPUT_PARENT" ] || exit 64
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT="$OUTPUT_PARENT/$(basename "$OUTPUT")"
BUILDER_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
UUID_SOURCE="$BUILDER_DIRECTORY/runtime-raiders-macho-uuid.c"
[ -f "$UUID_SOURCE" ] && [ ! -L "$UUID_SOURCE" ] || exit 64

temporary_paths=()
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  for ((index=0; index < ${#temporary_paths[@]}; index++)); do
    /bin/rm -f -- "${temporary_paths[$index]}"
  done
  [ ! -e "$SCRATCH" ] || /bin/rm -rf -- "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

uuid_tool="$OUTPUT_PARENT/.runtime-raiders-macho-uuid.$$"
[ ! -e "$uuid_tool" ] && [ ! -L "$uuid_tool" ] || exit 1
temporary_paths+=("$uuid_tool")
/usr/bin/clang -std=c11 -Wall -Wextra -Werror "$UUID_SOURCE" -o "$uuid_tool"
chmod 700 "$uuid_tool"

for architecture in arm64 x86_64; do
  /usr/bin/swift build \
    --disable-sandbox \
    --package-path "$PACKAGE" \
    --scratch-path "$SCRATCH" \
    --configuration release \
    --arch "$architecture" \
    --disable-automatic-resolution \
    --skip-update \
    --jobs 1 \
    --product runtime-raiders-release-validator \
    -Xswiftc -file-prefix-map \
    -Xswiftc "$SCRATCH=/runtime-raiders-release-validator-build" \
    -Xswiftc -debug-prefix-map \
    -Xswiftc "$SCRATCH=/runtime-raiders-release-validator-build" \
    -Xcc "-ffile-prefix-map=$SCRATCH=/runtime-raiders-release-validator-build" >/dev/null
  source="$SCRATCH/$architecture-apple-macosx/release/runtime-raiders-release-validator"
  slice="$OUTPUT_PARENT/$(basename "$OUTPUT")-$architecture"
  [ ! -e "$slice" ] && [ ! -L "$slice" ] || exit 1
  /bin/cp "$source" "$slice"
  temporary_paths+=("$slice")
  /usr/bin/codesign --remove-signature "$slice"
  /usr/bin/strip -S -x "$slice"
  "$uuid_tool" "$slice" --zero
  slice_digest="$(/usr/bin/shasum -a 256 "$slice" | /usr/bin/awk 'NR == 1 { print $1 }')"
  case "$slice_digest" in ''|*[!0-9a-f]*) exit 1 ;; esac
  [ "${#slice_digest}" -eq 64 ] || exit 1
  "$uuid_tool" "$slice" --set-sha256 "$slice_digest"
  "$uuid_tool" "$slice" --verify
  /usr/bin/codesign --force --sign - --timestamp=none \
    --identifier com.redlattice.runtime-raiders-release-validator "$slice"
  /usr/bin/codesign --verify --strict "$slice"
  chmod 755 "$slice"
done

/usr/bin/lipo -create \
  "$OUTPUT-arm64" \
  "$OUTPUT-x86_64" \
  -output "$OUTPUT"
temporary_paths+=("$OUTPUT")
/usr/bin/lipo "$OUTPUT" -verify_arch arm64 x86_64
/usr/bin/codesign --verify --strict --all-architectures "$OUTPUT"
chmod 755 "$OUTPUT"

/bin/rm -f -- "$OUTPUT-arm64" "$OUTPUT-x86_64" "$uuid_tool"
temporary_paths=()
trap - EXIT HUP INT TERM
