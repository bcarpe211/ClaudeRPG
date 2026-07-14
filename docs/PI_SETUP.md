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
git clone <your-repo-url> ~/ClaudeRPG
cd ~/ClaudeRPG
```
The Oryx art pack must be present under `assets/oryx_16-bit_fantasy_1.1/Sliced/`.

> **Prefer a fresh `git clone`.** If you copy the folder from another machine,
> do **not** copy its `node_modules/` — a native `better-sqlite3` binary built
> for a different OS/arch will crash the server with `ERR_DLOPEN_FAILED`.
> (`setup.sh` now wipes `node_modules` and reinstalls cleanly, so it self-heals,
> but copying it just wastes time.)

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
- **"Unlock Keyring" dialog on boot before the game shows:** Chromium tried to
  use the GNOME keyring, which autologin leaves locked. `kiosk.sh` passes
  `--password-store=basic` to avoid it; if you still see the prompt, confirm that
  flag is present in `scripts/pi/kiosk.sh` and reboot. (Belt-and-suspenders: you
  can also set an empty keyring password via `seahorse`, but the flag is enough.)
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
- **Mouse cursor showing on the TV:** the installer hides it with a transparent
  XCURSOR theme (`setup.sh` step 7b). To temporarily bring the pointer back (e.g.
  to operate the Pi directly) and hide it again:
  ```bash
  ssh rluser@claude-rpg.local 'cd ~/ClaudeRPG && bash scripts/pi/cursor.sh show'  # reboots to apply
  ssh rluser@claude-rpg.local 'cd ~/ClaudeRPG && bash scripts/pi/cursor.sh hide'
  ```
  Add `--no-reboot` to stage the change without rebooting. (CSS `cursor:none`
  alone doesn't work: Chromium only hides the pointer once it moves over the
  page, which never happens on a kiosk; and `unclutter` is X11-only.)

## Updating the game

**Manual:**
```bash
cd ~/ClaudeRPG && git pull --ff-only && sudo systemctl restart claude-rpg
# add `npm ci` only if package-lock.json changed in the pull
```
(The kiosk page auto-reconnects via SSE; refresh isn't usually needed, but you
can reboot for a clean slate.)

### Automatic updates during downtime

A systemd timer (`claude-rpg-autoupdate.timer`) checks every ~2 min and, **only
when the game is idle-paused** (`game_state.paused=1` — "the dungeon rests"),
fast-forward-pulls `origin/main` and restarts the service. It never interrupts a
live fight, never touches `data/`/`node_modules`, and holds off on a dirty or
diverged tree. Restarts are safe: state persists in SQLite (WAL + graceful
shutdown), so an idle-window restart is invisible.

Install (one-time):
```bash
sudo install -m 755 ~/ClaudeRPG/scripts/pi/auto-update.sh /usr/local/bin/claude-rpg-autoupdate
sudo cp ~/ClaudeRPG/deploy/claude-rpg-autoupdate.service ~/ClaudeRPG/deploy/claude-rpg-autoupdate.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-rpg-autoupdate.timer
```
Inspect: `systemctl list-timers claude-rpg-autoupdate` · logs
`journalctl -u claude-rpg-autoupdate -n 30`. Force a check now (respects the
idle gate): `sudo systemctl start claude-rpg-autoupdate`. Disable:
`sudo systemctl disable --now claude-rpg-autoupdate.timer`. After editing the
script in the repo, re-copy it to `/usr/local/bin/claude-rpg-autoupdate`.

## Uninstall
```bash
bash scripts/pi/uninstall.sh
```
