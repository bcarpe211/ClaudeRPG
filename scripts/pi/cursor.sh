#!/usr/bin/env bash
# Show or hide the kiosk mouse cursor (labwc / Wayland).
#
# The kiosk normally hides the pointer with a fully-transparent XCURSOR theme
# set in ~/.config/labwc/environment. Run this over SSH to temporarily restore
# the pointer (e.g. to poke at something on the Pi) and to hide it again.
#
#   bash scripts/pi/cursor.sh show              # restore the normal pointer
#   bash scripts/pi/cursor.sh hide              # hide the pointer (kiosk default)
#   bash scripts/pi/cursor.sh show --no-reboot  # stage the change, apply later
#
# labwc reads ~/.config/labwc/environment once at session start, so changes take
# effect after the Wayland session restarts. By default this reboots; pass
# --no-reboot to stage the change and reboot yourself later.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVF="$HOME/.config/labwc/environment"

ACTION="${1:-}"
NO_REBOOT=0
for a in "${@:2}"; do [ "$a" = "--no-reboot" ] && NO_REBOOT=1; done

strip_xcursor() {
  mkdir -p "$(dirname "$ENVF")"
  touch "$ENVF"
  grep -vE '^XCURSOR_(THEME|SIZE)=' "$ENVF" > "$ENVF.tmp" 2>/dev/null || true
  mv "$ENVF.tmp" "$ENVF"
}

case "$ACTION" in
  hide)
    python3 "$SCRIPT_DIR/gen-transparent-cursor.py"
    strip_xcursor
    printf 'XCURSOR_THEME=transparent\nXCURSOR_SIZE=24\n' >> "$ENVF"
    echo "Cursor HIDDEN (transparent theme)."
    ;;
  show)
    strip_xcursor
    echo "Cursor SHOWN (default theme restored)."
    ;;
  *)
    echo "usage: $(basename "$0") {show|hide} [--no-reboot]" >&2
    exit 2
    ;;
esac

if [ "$NO_REBOOT" -eq 1 ]; then
  echo "Staged. Apply with: sudo systemctl reboot"
else
  echo "Rebooting to apply..."
  sudo systemctl reboot
fi
