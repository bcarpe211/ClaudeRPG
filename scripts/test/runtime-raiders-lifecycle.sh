#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-gate1.XXXXXX")"
gate_root="$(cd "$gate_root" && pwd -P)"
gate_parent="$(cd "${gate_root%/*}" && pwd -P)"
gate_owner="$(id -u)"
chmod 700 "$gate_root"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$gate_root" in
    "$gate_parent"/runtime-raiders-gate1.*) ;;
    *) exit 1 ;;
  esac
  if [ -e "$gate_root" ] || [ -L "$gate_root" ]; then
    [ -d "$gate_root" ] && [ ! -L "$gate_root" ] || exit 1
    [ "$(/usr/bin/stat -f '%u' "$gate_root")" = "$gate_owner" ] || exit 1
    /bin/rm -rf -- "$gate_root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -m 700 "$gate_root/tmp" "$gate_root/clang-cache" "$gate_root/swiftpm-cache"
export TMPDIR="$gate_root/tmp"
export CLANG_MODULE_CACHE_PATH="$gate_root/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$gate_root/swiftpm-cache"
export RUNTIME_RAIDERS_TEST_FAKE_NETWORK=1
export RUNTIME_RAIDERS_TEST_FAKE_LAUNCHD=1

sh -n companion/packaging/install.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
swift test --disable-sandbox --package-path companion
npx vitest run tests/companion-installer.test.ts
