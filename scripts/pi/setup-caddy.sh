#!/bin/bash

# One-time, separately authorized Runtime Raiders beta publication bootstrap.
# Normal beta publication never invokes this script, installs config, or reloads Caddy.
set -euo pipefail
umask 022

usage() {
  echo "usage: $0 runtime-raiders-beta-bootstrap" >&2
  exit 64
}
[ "$#" -eq 1 ] && [ "$1" = runtime-raiders-beta-bootstrap ] || usage

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DEST_ROOT=''
CADDY_TOOL=/usr/bin/caddy
SYSTEMCTL_TOOL=/usr/bin/systemctl
VISUDO_TOOL=/usr/sbin/visudo
TEST_MODE=0

invalid_test_configuration() {
  echo "Caddy bootstrap test configuration is invalid" >&2
  exit 64
}
validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) invalid_test_configuration ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || invalid_test_configuration
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$(/usr/bin/id -u)" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || invalid_test_configuration
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || invalid_test_configuration
}

if [ -n "${RUNTIME_RAIDERS_CADDY_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_CADDY_TEST_MODE" = 1 ] || invalid_test_configuration
  TEST_MODE=1
  DEST_ROOT="${RUNTIME_RAIDERS_CADDY_TEST_ROOT:-}"
  CADDY_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_CADDY:-}"
  SYSTEMCTL_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL:-}"
  VISUDO_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_VISUDO:-}"
  case "$DEST_ROOT" in /*) ;; *) invalid_test_configuration ;; esac
  [ -d "$DEST_ROOT" ] && [ ! -L "$DEST_ROOT" ] || invalid_test_configuration
  for tool in "$CADDY_TOOL" "$SYSTEMCTL_TOOL" "$VISUDO_TOOL"; do validate_test_tool "$tool"; done
else
  for injected_name in RUNTIME_RAIDERS_CADDY_TEST_ROOT RUNTIME_RAIDERS_CADDY_TEST_CADDY \
    RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL RUNTIME_RAIDERS_CADDY_TEST_VISUDO; do
    [ -z "${!injected_name:-}" ] || invalid_test_configuration
  done
fi

target() { printf '%s%s\n' "$DEST_ROOT" "$1"; }
as_root() {
  if [ "$TEST_MODE" = 1 ]; then "$@"; else /usr/bin/sudo "$@"; fi
}
install_owned() {
  if [ "$TEST_MODE" = 1 ]; then
    as_root /usr/bin/install "$@"
  else
    as_root /usr/bin/install -o root -g root "$@"
  fi
}

if [ ! -x "$CADDY_TOOL" ] || ! "$CADDY_TOOL" list-modules 2>/dev/null | /usr/bin/grep -q dns.providers.cloudflare; then
  [ "$TEST_MODE" = 0 ] || invalid_test_configuration
  echo "Downloading Caddy (linux/arm64 + Cloudflare DNS plugin)..."
  candidate="$(/usr/bin/mktemp)"
  cleanup() { /bin/rm -f -- "$candidate"; }
  trap cleanup EXIT HUP INT TERM
  /usr/bin/curl -fsSL -o "$candidate" "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/cloudflare"
  install_owned -m 0755 "$candidate" /usr/bin/caddy
  CADDY_TOOL=/usr/bin/caddy
  cleanup
  trap - EXIT HUP INT TERM
fi
"$CADDY_TOOL" list-modules | /usr/bin/grep -q dns.providers.cloudflare || {
  echo "Caddy Cloudflare DNS module is missing" >&2
  exit 1
}
"$CADDY_TOOL" validate --config "$REPO_DIR/deploy/Caddyfile"
/bin/bash -n "$REPO_DIR/scripts/pi/publish-runtime-raiders-beta.sh"
"$VISUDO_TOOL" -cf "$REPO_DIR/deploy/runtime-raiders-publish.sudoers"

if [ "$TEST_MODE" = 0 ]; then
  as_root /usr/sbin/useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  as_root /usr/bin/install -d -m 0755 -o caddy -g caddy /var/lib/caddy
fi
install_owned -d -m 0755 "$(target /etc/caddy)" "$(target /etc/systemd/system)"
install_owned -d -m 0755 "$(target /var/lib/runtime-raiders)" "$(target /var/lib/runtime-raiders/public)"
install_owned -d -m 0700 "$(target /var/lib/runtime-raiders/staging)"
install_owned -d -m 0755 "$(target /usr/local/sbin)" "$(target /etc/sudoers.d)"

install_owned -m 0755 \
  "$REPO_DIR/scripts/pi/publish-runtime-raiders-beta.sh" \
  "$(target /usr/local/sbin/runtime-raiders-publish)"
/bin/bash -n "$(target /usr/local/sbin/runtime-raiders-publish)"
/usr/bin/cmp -s "$REPO_DIR/scripts/pi/publish-runtime-raiders-beta.sh" \
  "$(target /usr/local/sbin/runtime-raiders-publish)" || {
  echo "installed Runtime Raiders publisher does not match reviewed source" >&2
  exit 1
}
install_owned -m 0440 \
  "$REPO_DIR/deploy/runtime-raiders-publish.sudoers" \
  "$(target /etc/sudoers.d/runtime-raiders-publish)"
as_root "$VISUDO_TOOL" -cf "$(target /etc/sudoers.d/runtime-raiders-publish)"
if [ "$TEST_MODE" = 0 ]; then
  [ "$(/usr/bin/stat -c '%U:%G:%a' /usr/local/sbin/runtime-raiders-publish)" = root:root:755 ] &&
    [ "$(/usr/bin/stat -c '%U:%G:%a' /etc/sudoers.d/runtime-raiders-publish)" = root:root:440 ] || {
    echo "installed publisher or sudo rule ownership is invalid" >&2
    exit 1
  }
fi

install_owned -m 0644 "$REPO_DIR/deploy/Caddyfile" "$(target /etc/caddy/Caddyfile)"
install_owned -m 0644 "$REPO_DIR/deploy/caddy.service" "$(target /etc/systemd/system/caddy.service)"
if [ ! -f "$(target /etc/caddy/cloudflare.env)" ]; then
  install_owned -m 0600 \
    "$REPO_DIR/deploy/cloudflare.env.example" "$(target /etc/caddy/cloudflare.env)"
fi

"$CADDY_TOOL" validate --config "$(target /etc/caddy/Caddyfile)"
as_root "$SYSTEMCTL_TOOL" daemon-reload
as_root "$SYSTEMCTL_TOOL" reload caddy

echo "Runtime Raiders beta Caddy bootstrap installed and reloaded."
echo "Normal releases now use the fixed root-owned publisher without reloading Caddy."
