#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

gate_owner="$(id -u)"
owns_gate_root=0

make_gate_root() {
  gate_root="$(mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-gate1.XXXXXX")"
  gate_root="$(cd "$gate_root" && pwd -P)"
  gate_parent="$(cd "${gate_root%/*}" && pwd -P)"
  chmod 700 "$gate_root"
  owns_gate_root=1
}

if [ "${RUNTIME_RAIDERS_GATE1_SANDBOXED:-}" != 1 ]; then
  make_gate_root
else
  gate_root="${RUNTIME_RAIDERS_GATE1_ROOT:-}"
  if [ -n "$gate_root" ]; then
    gate_root="$(cd "$gate_root" && pwd -P)"
    gate_parent="$(cd "${gate_root%/*}" && pwd -P)"
  else
    make_gate_root
  fi
  unset RUNTIME_RAIDERS_GATE1_ROOT
fi
gate_parent="$(cd "${gate_root%/*}" && pwd -P)"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$gate_root" in
    "$gate_parent"/runtime-raiders-gate1.*) ;;
    *) exit 1 ;;
  esac
  if [ "$owns_gate_root" -eq 1 ] && { [ -e "$gate_root" ] || [ -L "$gate_root" ]; }; then
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

if [ "${RUNTIME_RAIDERS_GATE1_SANDBOXED:-}" != 1 ]; then
  original_home="$(cd "${HOME:?}" && pwd -P)"
  real_support="$original_home/Library/Application Support/Runtime Raiders"
  mkdir -m 700 "$gate_root/os-boundary-protected"
  /usr/bin/sandbox-exec \
    -D "RUNTIME_RAIDERS_REAL_SUPPORT=$real_support" \
    -D "RUNTIME_RAIDERS_GATE1_PROTECTED=$gate_root/os-boundary-protected" \
    -f "$ROOT/scripts/test/runtime-raiders-gate1.sb" \
    /usr/bin/env \
      RUNTIME_RAIDERS_GATE1_SANDBOXED=1 \
      RUNTIME_RAIDERS_GATE1_ROOT="$gate_root" \
      RUNTIME_RAIDERS_GATE1_PROTECTED="$gate_root/os-boundary-protected" \
      /bin/bash "$ROOT/scripts/test/runtime-raiders-lifecycle.sh"
  exit $?
fi

mkdir -m 700 \
  "$gate_root/home" \
  "$gate_root/home/Library" \
  "$gate_root/home/Library/Application Support" \
  "$gate_root/home/Library/Caches" \
  "$gate_root/home/.config" \
  "$gate_root/home/.cache" \
  "$gate_root/tmp" \
  "$gate_root/clang-cache" \
  "$gate_root/swiftpm-cache" \
  "$gate_root/swift-scratch" \
  "$gate_root/npm-cache" \
  "$gate_root/boundary-bin"

for command in curl launchctl scp ssh; do
  printf '%s\n' '#!/bin/sh' 'echo "Gate 1 blocked a live external boundary" >&2' 'exit 97' > "$gate_root/boundary-bin/$command"
  chmod 700 "$gate_root/boundary-bin/$command"
done

export HOME="$gate_root/home"
export CFFIXED_USER_HOME="$gate_root/home"
export TMPDIR="$gate_root/tmp"
export CLANG_MODULE_CACHE_PATH="$gate_root/clang-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$gate_root/swiftpm-cache"
export XDG_CONFIG_HOME="$gate_root/home/.config"
export XDG_CACHE_HOME="$gate_root/home/.cache"
export npm_config_cache="$gate_root/npm-cache"
export npm_config_userconfig="$gate_root/home/.npmrc"
export npm_config_offline=true
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export PATH="$gate_root/boundary-bin:$PATH"
export RUNTIME_RAIDERS_TEST_FAKE_NETWORK=1
export RUNTIME_RAIDERS_TEST_FAKE_LAUNCHD=1
export RUNTIME_RAIDERS_GATE1_SANDBOXED=1

sh -n companion/packaging/install.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
swift test --disable-sandbox --package-path companion \
  --scratch-path "$gate_root/swift-scratch" \
  --disable-automatic-resolution \
  --skip-update
npx --no-install vitest run --no-file-parallelism \
  tests/companion-installer.test.ts \
  tests/runtime-raiders-release-gates.test.ts
