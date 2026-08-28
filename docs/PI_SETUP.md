# Runtime Raiders — Raspberry Pi 5 Kiosk Setup

Turns a Pi 5 + TV into an unattended Runtime Raiders display: the server starts on
boot, Chromium opens full-screen on `/tv`, and the Pi is reachable on the LAN as
`raiders.local`.

Compatibility identifiers intentionally retained for this release:
/home/rluser/ClaudeRPG, data/claude-rpg.db, /etc/claude-rpg.env,
claude-rpg.service, and claude-rpg-autoupdate.*

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
the hostname to `raiders`; installs the systemd service + `/etc/claude-rpg.env`;
enables desktop autologin; and installs the Chromium kiosk autostart. It is safe
to re-run. Fresh setup leaves `SCORING_MODE=disabled`. On the first run, setup
also refuses to restart the service while the shipped admin password or any
unsafe Runtime Raiders value remains; edit the environment and rerun setup.

## 4. Set the admin password, rerun setup, then reboot
```bash
sudo nano /etc/claude-rpg.env     # set ADMIN_PASSWORD; keep SCORING_MODE=disabled
bash scripts/pi/setup.sh           # validates the env before service restart
sudo reboot
```
After reboot the TV should show the dungeon. From your laptop:
- Internal DNS: `https://raiders.redlattice.com/admin` (user `admin`)
- mDNS: `http://raiders.local:8080/admin` (user `admin`)
- Register via mDNS: `http://raiders.local:8080/`

Both names are for internal-network access only; neither creates public ingress.

## 5. Use the current Runtime Raiders runbooks

The [Runtime Raiders documentation authority map](runtime-raiders/README.md)
is the only active entry point. Use [employee beta](runtime-raiders/employee-beta.md)
for companion onboarding/publication and [server deployment](runtime-raiders/server-deployment.md)
for a separately authorized paused-dungeon server change. Fresh Pi setup does
not authorize publication, deployment, or employee collection. Retired
sequence, launcher, and canary records are archived evidence and must not be
executed.

## On-Pi verification checklist
- [ ] `systemctl status claude-rpg` → **active (running)**.
- [ ] `curl -fs http://localhost:8080/health` → `{"ok":true}`.
- [ ] From a laptop on the internal network: `ping raiders.local` resolves and
      `https://raiders.redlattice.com` loads.
- [ ] The TV shows the kiosk (dungeon + leaderboard), no desktop/cursor/bars.
- [ ] Follow the active Runtime Raiders authority map; use only its linked
      procedure for the requested operation.
- [ ] Register a character; run the one-line companion installer and confirm
      `raiders status` reports collection disabled before any separate office
      activation decision.
- [ ] Confirm Claude Code and Omp remain unavailable; do not configure or probe
      either provider.
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
- **`raiders.local` won't resolve:** confirm `avahi-daemon` is active and the
  client supports mDNS (most do); otherwise use the Pi's IP address.
- **Wrong/blurry resolution:** the renderer adapts to any resolution; to force
  4K use `wlr-randr` or Screen Configuration on the Pi.
- **Mouse cursor showing on the TV:** the installer hides it with a transparent
  XCURSOR theme (`setup.sh` step 7b). To temporarily bring the pointer back (e.g.
  to operate the Pi directly) and hide it again:
  ```bash
  ssh rluser@raiders.local 'cd ~/ClaudeRPG && bash scripts/pi/cursor.sh show'  # reboots to apply
  ssh rluser@raiders.local 'cd ~/ClaudeRPG && bash scripts/pi/cursor.sh hide'
  ```
  Add `--no-reboot` to stage the change without rebooting. (CSS `cursor:none`
  alone doesn't work: Chromium only hides the pointer once it moves over the
  page, which never happens on a kiosk; and `unclutter` is X11-only.)

## Releasing an update

Use the current [employee beta runbook](runtime-raiders/employee-beta.md) for
companion publication. Server changes use the separate
[server deployment procedure](runtime-raiders/server-deployment.md). Neither
procedure enables employee collection as a side effect.

### Release automation is disabled

The current `claude-rpg-autoupdate` timer and its oneshot remain disabled and
inactive after every terminal outcome: accepted cutover, abort, or rollback.
They follow moving `origin/main`, so an idle/paused game is not authorization to
release a future commit. Keep the current units disabled; do not install, enable,
or force-run them.

Any future automation needs separate design and review. It may be authorized only
for an explicitly approved pinned SHA and must recheck that SHA, the unit
contract, pause gate, ownership, environment, and database integrity before each
checkout or service start. Authorization for this cutover does not authorize a
future or rejected SHA.

## Uninstall
```bash
bash scripts/pi/uninstall.sh
```
