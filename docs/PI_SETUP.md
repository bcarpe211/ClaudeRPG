# ClaudeRPG — Raspberry Pi 5 Kiosk Setup

Turns a Pi 5 + TV into an unattended ClaudeRPG display: the server starts on
boot, Chromium opens full-screen on `/tv`, and the Pi is reachable on the LAN as
`claude-rpg.local`.

## 1. Flash the OS
- Use **Raspberry Pi Imager** → **Raspberry Pi OS (64-bit), Bookworm, *with desktop***.
- In the Imager's advanced options, optionally set the username and enable SSH +
  Wi‑Fi so you can finish setup headless.
- Boot the Pi, connect it to the network and the TV via HDMI.

## 2. Get the code onto the Pi
```bash
git clone <your-repo-url> ~/ClaudeRPG    # or copy the folder over
cd ~/ClaudeRPG
```
The Oryx art pack must be present under `assets/oryx_16-bit_fantasy_1.1/Sliced/`.

## 3. Run the installer
```bash
bash scripts/pi/setup.sh
```
This installs Node 22, Chromium, Avahi and build tools; runs `npm install`; sets
the hostname to `claude-rpg`; installs the systemd service + `/etc/claude-rpg.env`;
enables desktop autologin; and installs the Chromium kiosk autostart. It is safe
to re-run.

## 4. Set the admin password, then reboot
```bash
sudo nano /etc/claude-rpg.env     # set ADMIN_PASSWORD (and PORT if you like)
sudo systemctl restart claude-rpg
sudo reboot
```
After reboot the TV should show the dungeon. From your laptop:
- Admin: `http://claude-rpg.local:8080/admin` (user `admin`)
- Register: `http://claude-rpg.local:8080/`

## 5. Onboard players
Each teammate registers a character at `http://claude-rpg.local:8080/`, then
pastes the shown setup snippet into their shell (`~/.zshrc`/`~/.bashrc`) and opens
a new terminal. Their Claude Code token usage then streams to the Pi. (Off the
office network the snippet's `claude-rpg.local` simply won't resolve, so nothing
is sent — that's intended. `rpg_off`/`rpg_on` toggle it on-network.)

## On-Pi verification checklist
- [ ] `systemctl status claude-rpg` → **active (running)**.
- [ ] `curl -fs http://localhost:8080/health` → `{"ok":true}`.
- [ ] From a laptop on the LAN: `ping claude-rpg.local` resolves; the admin page loads.
- [ ] The TV shows the kiosk (dungeon + leaderboard), no desktop/cursor/bars.
- [ ] Register a character and send a quick Claude Code task → the hero appears
      and starts attacking within a few seconds.
- [ ] Reboot the Pi → it returns to the kiosk unattended.
- [ ] Pull power mid-fight, restore → the game resumes (state persisted in SQLite).
- [ ] Leave it idle past `pause_after_minutes` → "the dungeon rests" overlay; a
      new token resumes it.

## Troubleshooting
- **Server logs:** `journalctl -u claude-rpg -f`
- **`npm install` fails on `better-sqlite3`:** ensure Node ≥ 20 (`node -v`) and
  `build-essential python3` are installed (the installer does this); re-run setup.
- **TV blanks after a while:** install/enable an idle inhibitor —
  `sudo apt install swayidle` (the kiosk script uses it if present), or disable
  blanking in the compositor.
- **Kiosk didn't start but desktop did:** confirm `~/.config/labwc/autostart`
  exists and is executable; check the compositor (Pi 5 Bookworm = labwc). For
  wayfire, ensure the `[autostart]` entry is in `~/.config/wayfire.ini`.
- **`claude-rpg.local` won't resolve:** confirm `avahi-daemon` is active and the
  client supports mDNS (most do); otherwise use the Pi's IP address.
- **Wrong/blurry resolution:** the renderer adapts to any resolution; to force
  4K use `wlr-randr` or Screen Configuration on the Pi.

## Updating the game
```bash
cd ~/ClaudeRPG && git pull && npm install && sudo systemctl restart claude-rpg
```
(The kiosk page auto-reconnects via SSE; refresh isn't usually needed, but you
can reboot for a clean slate.)

## Uninstall
```bash
bash scripts/pi/uninstall.sh
```
