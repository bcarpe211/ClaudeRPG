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
  mkdir -m 700 "$probe_root/$run-output"
  "$ROOT/scripts/release/build-runtime-raiders-release-validator.sh" \
    "$ROOT/companion" \
    "$probe_root/$run-scratch" \
    "$probe_root/$run-output/runtime-raiders-release-validator"
  [ ! -e "$probe_root/$run-scratch" ] && [ ! -L "$probe_root/$run-scratch" ] || {
    echo "release-validator builder retained its owned scratch for $run" >&2
    exit 1
  }
done

cmp -s \
  "$probe_root/one-output/runtime-raiders-release-validator" \
  "$probe_root/two-output/runtime-raiders-release-validator" || {
  echo "clean release-validator builds are not byte reproducible" >&2
  exit 1
}

printf '%s\n' \
  'usage: runtime-raiders-release-validator archive.zip [extracted-root sequence sha version protocol team]' \
  > "$probe_root/expected-usage"
for run in one two; do
  validator="$probe_root/$run-output/runtime-raiders-release-validator"
  /usr/bin/lipo "$validator" -verify_arch arm64 x86_64
  if "$validator" > "$probe_root/$run.stdout" 2> "$probe_root/$run.stderr"; then
    echo "release validator unexpectedly accepted an empty invocation" >&2
    exit 1
  else
    validator_status=$?
  fi
  [ "$validator_status" -eq 64 ] || {
    echo "release validator did not reach its harmless usage path: status $validator_status" >&2
    exit 1
  }
  [ ! -s "$probe_root/$run.stdout" ] || exit 1
  cmp -s "$probe_root/expected-usage" "$probe_root/$run.stderr" || exit 1
  /usr/bin/codesign --verify --strict --all-architectures "$validator"
  uuid_arches="$(/usr/bin/dwarfdump --uuid "$validator" | /usr/bin/awk '
    /^UUID: [0-9A-F-]+ \(arm64\) / { arm64 += 1; next }
    /^UUID: [0-9A-F-]+ \(x86_64\) / { x86 += 1; next }
    { bad += 1 }
    END {
      if (arm64 == 1 && x86 == 1 && bad == 0) print "arm64 x86_64"
      else exit 1
    }
  ')" || exit 1
  [ "$uuid_arches" = 'arm64 x86_64' ] || exit 1
done

one_sha="$(/usr/bin/shasum -a 256 "$probe_root/one-output/runtime-raiders-release-validator" | /usr/bin/awk 'NR == 1 { print $1 }')"
two_sha="$(/usr/bin/shasum -a 256 "$probe_root/two-output/runtime-raiders-release-validator" | /usr/bin/awk 'NR == 1 { print $1 }')"
[ "$one_sha" = "$two_sha" ] || exit 1
