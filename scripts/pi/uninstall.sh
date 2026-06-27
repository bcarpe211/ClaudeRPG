#!/usr/bin/env bash
# Remove the ClaudeRPG service + kiosk autostart (leaves the repo + data).
set -uo pipefail
echo "-- stopping + disabling service --"
sudo systemctl disable --now claude-rpg.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/claude-rpg.service
sudo systemctl daemon-reload
echo "-- removing kiosk autostart --"
rm -f "$HOME/.config/labwc/autostart"
sed -i '/claude_rpg/d' "$HOME/.config/wayfire.ini" 2>/dev/null || true
echo "Done. /etc/claude-rpg.env and the repo/data were left in place."
echo "(To fully remove: sudo rm /etc/claude-rpg.env and delete the repo.)"
