#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-validator-reproducibility.XXXXXX")"
probe_root="$(cd "$probe_root" && pwd -P)"
probe_parent="$(cd "${probe_root%/*}" && pwd -P)"
owner="$(id -u)"
chmod 700 "$probe_root"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$probe_root" in "$probe_parent"/runtime-raiders-validator-reproducibility.*) ;; *) exit 1 ;; esac
  [ -d "$probe_root" ] && [ ! -L "$probe_root" ] || exit 1
  [ "$(/usr/bin/stat -f '%u' "$probe_root")" = "$owner" ] || exit 1
  /bin/rm -rf -- "$probe_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for run in one two; do
  "$ROOT/scripts/release/build-runtime-raiders-release-validator.sh" \
    "$ROOT/companion" \
    "$probe_root/$run-scratch" \
    "$probe_root/$run-validator"
done

cmp -s "$probe_root/one-validator" "$probe_root/two-validator" || {
  echo "clean release-validator builds are not byte reproducible" >&2
  exit 1
}
