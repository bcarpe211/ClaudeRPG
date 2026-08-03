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
to re-run.

## 4. Set the admin password, then reboot
```bash
sudo nano /etc/claude-rpg.env     # set ADMIN_PASSWORD (and PORT if you like)
sudo systemctl restart claude-rpg
sudo reboot
```
After reboot the TV should show the dungeon. From your laptop:
- Internal DNS: `https://raiders.redlattice.com/admin` (user `admin`)
- mDNS: `http://raiders.local:8080/admin` (user `admin`)
- Register via mDNS: `http://raiders.local:8080/`

Both names are for internal-network access only; neither creates public ingress.

## 5. Onboard players
Each teammate registers a character at `http://raiders.local:8080/`. Registration
provides a private, one-time companion installer for that Raider; run it once on
the owner's Mac. The installer starts collection **off** and never edits shell or
provider configuration.

Before opting in, run `raiders status` (and `raiders doctor` if it reports a
problem) and confirm collection is disabled. Consent is explicit: run
`raiders on` only when the owner wants Runtime Raiders collection, and run
`raiders off` to stop it. Use separate controlled canaries for Codex Desktop and
Codex CLI. With Raiders off, both canaries must work normally and produce no
Runtime Raiders upload; after explicit opt-in, verify each allowed surface
separately.

Only Codex Desktop and Codex CLI are available in this release. Claude Code and
Omp are unavailable and unsupported. Manually remove the legacy Claude OTel
shell configuration and old `rpg_*` commands, then start a fresh shell. The
companion installer does not remove or change legacy shell configuration for you.

## On-Pi verification checklist
- [ ] `systemctl status claude-rpg` → **active (running)**.
- [ ] `curl -fs http://localhost:8080/health` → `{"ok":true}`.
- [ ] From a laptop on the internal network: `ping raiders.local` resolves and
      `https://raiders.redlattice.com` loads.
- [ ] The TV shows the kiosk (dungeon + leaderboard), no desktop/cursor/bars.
- [ ] Register a character; run the one-time companion installer and confirm
      `raiders status` reports collection disabled before consent.
- [ ] With Raiders off, complete harmless Codex Desktop and Codex CLI canaries:
      both work normally and neither uploads Runtime Raiders data.
- [ ] After explicit `raiders on`, complete a controlled Codex Desktop canary
      and a separate controlled Codex CLI canary; confirm each allowed surface
      is recorded as expected. Run `raiders off` when the canaries finish.
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

Every release, including a routine update, must follow the exact recorded,
pinned-SHA, and separately authorized procedure in
[`docs/RUNTIME_RAIDERS_CUTOVER.md`](RUNTIME_RAIDERS_CUTOVER.md). That procedure
rechecks the pause and updater holds, approved SHA, environment, ownership,
database backup and integrity, service contract, and post-start verification.
There is no raw pull-and-restart release shortcut.

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
