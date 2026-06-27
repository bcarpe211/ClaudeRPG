#!/usr/bin/env bash
# One-shot, idempotent ClaudeRPG Pi 5 kiosk installer. Run as the kiosk user:
#   bash scripts/pi/setup.sh
# Re-runnable. Uses sudo for system changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
KIOSK_USER="$(id -un)"
HOSTNAME_WANT="claude-rpg"
ENV_FILE="/etc/claude-rpg.env"
UNIT_DST="/etc/systemd/system/claude-rpg.service"

echo "== ClaudeRPG Pi setup =="
echo "repo:  $REPO_DIR"
echo "user:  $KIOSK_USER"

if [ "$KIOSK_USER" = "root" ]; then
  echo "Run as your normal kiosk user (not root); it will sudo as needed." >&2
  exit 1
fi

# --- 1. System packages -----------------------------------------------------
echo "-- installing packages (node, chromium, avahi, build tools) --"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "   installing Node.js 22 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  chromium-browser avahi-daemon curl build-essential python3 || \
  sudo apt-get install -y --no-install-recommends \
  chromium avahi-daemon curl build-essential python3

# --- 2. App dependencies ----------------------------------------------------
echo "-- installing app dependencies --"
( cd "$REPO_DIR" && npm install --include=dev )
mkdir -p "$REPO_DIR/data"

# --- 3. Hostname + mDNS -----------------------------------------------------
echo "-- setting hostname to $HOSTNAME_WANT (mDNS: $HOSTNAME_WANT.local) --"
if [ "$(hostnamectl --static)" != "$HOSTNAME_WANT" ]; then
  sudo hostnamectl set-hostname "$HOSTNAME_WANT"
  if grep -qE '^127\.0\.1\.1' /etc/hosts; then
    sudo sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME_WANT/" /etc/hosts
  else
    echo -e "127.0.1.1\t$HOSTNAME_WANT" | sudo tee -a /etc/hosts >/dev/null
  fi
fi
sudo systemctl enable --now avahi-daemon

# --- 4. Env file ------------------------------------------------------------
echo "-- installing $ENV_FILE --"
if [ ! -f "$ENV_FILE" ]; then
  sudo cp "$REPO_DIR/deploy/claude-rpg.env.example" "$ENV_FILE"
  sudo sed -i "s#__REPO__#$REPO_DIR#g" "$ENV_FILE"
  # generate a random session secret
  SECRET="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )"
  sudo sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=$SECRET#" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
  echo "   created $ENV_FILE — EDIT IT to set ADMIN_PASSWORD."
else
  echo "   $ENV_FILE already exists; leaving it untouched."
fi

# --- 5. systemd service -----------------------------------------------------
echo "-- installing systemd service --"
sudo sed -e "s#__USER__#$KIOSK_USER#g" -e "s#__REPO__#$REPO_DIR#g" \
  "$REPO_DIR/deploy/claude-rpg.service" | sudo tee "$UNIT_DST" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable claude-rpg.service
sudo systemctl restart claude-rpg.service

# --- 6. Desktop autologin ---------------------------------------------------
echo "-- enabling desktop autologin --"
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_boot_behaviour B4 || \
    echo "   (could not set autologin automatically; set it via raspi-config)"
else
  echo "   raspi-config not found; enable 'Desktop Autologin' manually."
fi

# --- 7. Kiosk autostart (labwc primary, wayfire fallback) -------------------
echo "-- installing kiosk autostart --"
mkdir -p "$HOME/.config/labwc"
sed "s#__REPO__#$REPO_DIR#g" "$REPO_DIR/deploy/labwc-autostart" > "$HOME/.config/labwc/autostart"
chmod +x "$HOME/.config/labwc/autostart"
# wayfire fallback: only append if wayfire.ini exists and lacks our entry
if [ -f "$HOME/.config/wayfire.ini" ] && ! grep -q "claude_rpg" "$HOME/.config/wayfire.ini"; then
  sed "s#__REPO__#$REPO_DIR#g" "$REPO_DIR/deploy/wayfire-kiosk.ini" >> "$HOME/.config/wayfire.ini"
fi

echo ""
echo "== Done. Next steps =="
echo "  1) sudo nano $ENV_FILE   # set ADMIN_PASSWORD"
echo "  2) sudo systemctl restart claude-rpg   # pick up the password"
echo "  3) sudo reboot           # boot into the kiosk"
echo "  Server:  http://claude-rpg.local:$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)/"
echo "  TV:      http://claude-rpg.local:$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)/tv   (shown on the Pi's HDMI)"
