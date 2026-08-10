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

temporary_paths=()
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  for path in "${temporary_paths[@]}"; do /bin/rm -f -- "$path"; done
  [ ! -e "$SCRATCH" ] || /bin/rm -rf -- "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
    -Xcc "-ffile-prefix-map=$SCRATCH=/runtime-raiders-release-validator-build" \
    -Xlinker -no_uuid >/dev/null
  source="$SCRATCH/$architecture-apple-macosx/release/runtime-raiders-release-validator"
  slice="$OUTPUT_PARENT/$(basename "$OUTPUT")-$architecture"
  [ ! -e "$slice" ] && [ ! -L "$slice" ] || exit 1
  /bin/cp "$source" "$slice"
  temporary_paths+=("$slice")
  /usr/bin/codesign --remove-signature "$slice"
  /usr/bin/strip -S -x "$slice"
  chmod 755 "$slice"
done

/usr/bin/lipo -create \
  "$OUTPUT-arm64" \
  "$OUTPUT-x86_64" \
  -output "$OUTPUT"
temporary_paths+=("$OUTPUT")
/usr/bin/lipo "$OUTPUT" -verify_arch arm64 x86_64
chmod 755 "$OUTPUT"

temporary_paths=()
/bin/rm -f -- "$OUTPUT-arm64" "$OUTPUT-x86_64"
trap - EXIT HUP INT TERM
