#!/usr/bin/env bash
# Idempotent Caddy install for the ClaudeRPG Pi: a linux/arm64 Caddy build with the
# Cloudflare DNS plugin, reverse-proxying the Node app on :8080 with automatic TLS
# via the ACME DNS-01 challenge (works on an internal IP — no inbound needed).
#
# After running: put your Cloudflare token in /etc/caddy/cloudflare.env, then
#   sudo systemctl enable --now caddy
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 1) Caddy binary with the cloudflare DNS module (custom download — no Go build).
if ! command -v caddy >/dev/null 2>&1 || ! caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare; then
  echo "Downloading Caddy (linux/arm64 + cloudflare DNS plugin)..."
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/cloudflare"
  sudo install -m 0755 "$tmp" /usr/bin/caddy
  rm -f "$tmp"
fi
caddy version
caddy list-modules | grep -q dns.providers.cloudflare && echo "OK: cloudflare DNS module present"

# 2) caddy system user + data/config dirs (certs live in /var/lib/caddy).
sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
sudo mkdir -p /var/lib/caddy /etc/caddy
sudo chown -R caddy:caddy /var/lib/caddy

# 3) config + service; token env placeholder (never overwrite a real token).
sudo install -m 0644 "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo install -m 0644 "$REPO_DIR/deploy/caddy.service" /etc/systemd/system/caddy.service
if [ ! -f /etc/caddy/cloudflare.env ]; then
  sudo install -m 0600 -o root -g root "$REPO_DIR/deploy/cloudflare.env.example" /etc/caddy/cloudflare.env
  echo ">>> Set your Cloudflare API token in /etc/caddy/cloudflare.env <<<"
fi
sudo systemctl daemon-reload
echo
echo "Caddy installed. Next:"
echo "  1) sudo nano /etc/caddy/cloudflare.env   # paste the token"
echo "  2) sudo systemctl enable --now caddy"
echo "  3) journalctl -u caddy -f                 # watch it obtain the cert"
