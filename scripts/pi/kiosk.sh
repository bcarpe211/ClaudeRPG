#!/usr/bin/env bash
# Launched by the desktop session autostart. Waits for the server, disables
# screen blanking, and opens Chromium full-screen on the TV page.
set -uo pipefail

PORT="${PORT:-8080}"
URL="http://localhost:${PORT}/tv"

# 1) Wait (up to ~90s) for the server to answer /health.
for _ in $(seq 1 90); do
  if curl -fs "http://localhost:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

# 2) Disable screen blanking / DPMS where the tools exist (X11 and Wayland).
if command -v xset >/dev/null 2>&1; then
  xset s off || true; xset -dpms || true; xset s noblank || true
fi
# labwc/wlroots: run an idle inhibitor with no timeout if available.
if command -v swayidle >/dev/null 2>&1; then
  swayidle -w timeout 0 'true' >/dev/null 2>&1 &
fi

# 3) Pick the Chromium binary (Pi OS ships chromium-browser; some images chromium).
CHROME="$(command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME" ]; then
  echo "kiosk.sh: no chromium binary found" >&2
  exit 1
fi

# 4) Launch kiosk. --app gives a chrome-less window; flags suppress dialogs and
#    updates; ozone=wayland matches labwc/wayfire on Bookworm.
#    --password-store=basic stops Chromium from using the GNOME keyring (Secret
#    Service), which under autologin is locked and would pop an "Unlock Keyring"
#    dialog on boot. The kiosk stores no real passwords, so basic is fine.
exec "$CHROME" \
  --kiosk \
  --app="$URL" \
  --password-store=basic \
  --ozone-platform=wayland \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --no-first-run \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required
