#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

temporary_base="${TMPDIR:-/tmp}"
gate_root="$(/usr/bin/mktemp -d "$temporary_base/runtime-raiders-sequence8-preflight.XXXXXX")"
/bin/chmod 700 "$gate_root"

cleanup() {
  status=$?
  case "$gate_root" in
    "$temporary_base"/runtime-raiders-sequence8-preflight.*) ;;
    *) status=1; trap - EXIT HUP INT TERM; exit "$status" ;;
  esac
  if [ -d "$gate_root" ] && [ ! -L "$gate_root" ] &&
     [ "$(/usr/bin/stat -f '%u' "$gate_root")" = "$(/usr/bin/id -u)" ]; then
    /bin/rm -rf "$gate_root"
  else
    status=1
  fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/bin/mkdir -m 700 "$gate_root/home" "$gate_root/tmp" \
  "$gate_root/clang-cache" "$gate_root/swiftpm-cache" "$gate_root/npm-cache"
export HOME="$gate_root/home"
export CFFIXED_USER_HOME="$gate_root/home"
export TMPDIR="$gate_root/tmp"
export CLANG_MODULE_CACHE_PATH="$gate_root/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$gate_root/swiftpm-cache"
export npm_config_cache="$gate_root/npm-cache"
export npm_config_offline=true
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

sh -n companion/packaging/install.sh
sh -n companion/legacy-sequence8/migrate.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
bash -n scripts/test/verify-runtime-raiders-signed-release.sh

/usr/bin/swift test --disable-sandbox --package-path companion \
  --scratch-path "$gate_root/swift-scratch" \
  --disable-automatic-resolution \
  --skip-update

"$ROOT/node_modules/.bin/vitest" run --no-file-parallelism \
  tests/companion-installer.test.ts \
  tests/runtime-raiders-onboarding.test.ts \
  tests/runtime-raiders-publication-docs.test.ts \
  tests/runtime-raiders-sequence8-preflight.test.ts

echo "Runtime Raiders unsigned sequence-eight preflight passed"
