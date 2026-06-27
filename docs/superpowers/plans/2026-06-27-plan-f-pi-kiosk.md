# Plan F: Raspberry Pi 5 Deployment / Kiosk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Raspberry Pi 5 boot straight into ClaudeRPG with no keyboard/mouse: the Node server starts on boot as a systemd service, Chromium launches full-screen in kiosk mode pointed at `/tv`, the Pi is reachable on the LAN as `claude-rpg.local` (so players' OTEL snippets and the admin panel work), and it all survives reboots/power loss. Delivered as committed deploy artifacts + an idempotent one-shot installer + an operator guide.

**Architecture:** Two independent auto-start surfaces. (1) A **systemd system service** (`claude-rpg.service`) runs the Node server on boot, restarts on failure, and reads secrets from `/etc/claude-rpg.env`. (2) The desktop session **auto-logs in** and a compositor **autostart** runs `kiosk.sh`, which waits for the server's `/health`, disables screen blanking, and execs Chromium `--kiosk` at `http://localhost:PORT/tv`. **Avahi** publishes `claude-rpg.local`. A single `setup.sh` wires all of this idempotently; `PI_SETUP.md` documents flashing → setup → config → the on-Pi verification checklist.

**Tech stack / target:** Raspberry Pi OS (64-bit, **Bookworm**) **with desktop**, Pi 5. Desktop autologin + **labwc** (Pi 5's default Wayland compositor; wayfire fallback provided). Node 20+ installed via NodeSource (the project needs Node 20+ for `better-sqlite3` v12). Chromium from apt. No new app dependencies.

**Testability reality:** This plan is config + scripts + docs. The **automated gate** is `bash -n` (syntax) on every script, `shellcheck` where available, and structural correctness of the unit/desktop files. **Real verification happens on the Pi** via the checklist in `PI_SETUP.md` — the implementer cannot run systemd/Chromium/labwc on the dev machine, and must not pretend to. No `src/` changes, so `npm test` + `npm run typecheck` must stay green (125 tests).

---

## File Structure

```
deploy/
  claude-rpg.service          (systemd unit template, __USER__/__REPO__ placeholders)
  claude-rpg.env.example      (env file template; copied to /etc/claude-rpg.env)
  labwc-autostart             (labwc autostart line template)
  wayfire-kiosk.ini           (wayfire [autostart] snippet, fallback)
scripts/pi/
  run-server.sh               (ExecStart target: cd repo + npm start)
  kiosk.sh                    (wait for health, disable blanking, launch Chromium kiosk)
  setup.sh                    (idempotent one-shot installer)
  uninstall.sh                (remove service + autostart)
docs/
  PI_SETUP.md                 (operator guide + on-Pi verification checklist)
```

No changes under `src/` or `tests/`.

---

## Task 1: Server service + run script + env template

**Files:**
- Create: `deploy/claude-rpg.service`, `deploy/claude-rpg.env.example`, `scripts/pi/run-server.sh`

- [ ] **Step 1: Create `deploy/claude-rpg.service`** (placeholders filled by `setup.sh`)

```ini
[Unit]
Description=ClaudeRPG game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__USER__
WorkingDirectory=__REPO__
EnvironmentFile=/etc/claude-rpg.env
ExecStart=__REPO__/scripts/pi/run-server.sh
Restart=always
RestartSec=3
# Give the DB a moment to flush on stop
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create `deploy/claude-rpg.env.example`**

```bash
# Copied to /etc/claude-rpg.env by setup.sh (chmod 600). Edit ADMIN_PASSWORD!
# Port the server (and the player OTLP endpoint) listen on.
PORT=8080
# Admin panel password — CHANGE THIS.
ADMIN_PASSWORD=change-me-please
# Random string for session cookies — setup.sh generates one if left as-is.
SESSION_SECRET=change-me-too
# mDNS host shown in players' setup snippets (matches the Pi's hostname + .local).
OTEL_ENDPOINT_HOST=claude-rpg.local
# Persistent SQLite path + sprite dir are set to absolute repo paths by setup.sh.
DB_PATH=__REPO__/data/claude-rpg.db
SPRITES_DIR=__REPO__/assets/oryx_16-bit_fantasy_1.1/Sliced
```

- [ ] **Step 3: Create `scripts/pi/run-server.sh`**

```bash
#!/usr/bin/env bash
# ExecStart target for claude-rpg.service. Runs the Node server from the repo.
set -euo pipefail

# Resolve the repo root (this script lives in <repo>/scripts/pi/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

# NodeSource installs node/npm into /usr/bin; ensure it's on PATH for systemd.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

exec npm start
```

- [ ] **Step 4: Make the script executable and syntax-check it**

Run:
```bash
chmod +x scripts/pi/run-server.sh
bash -n scripts/pi/run-server.sh && echo "run-server.sh: syntax OK"
command -v shellcheck >/dev/null && shellcheck scripts/pi/run-server.sh || echo "(shellcheck not installed; skipped)"
```
Expected: "syntax OK" (and clean shellcheck if installed).

- [ ] **Step 5: Sanity-check the unit file structure**

Run:
```bash
grep -q '^\[Unit\]' deploy/claude-rpg.service && grep -q '^\[Service\]' deploy/claude-rpg.service && grep -q '^\[Install\]' deploy/claude-rpg.service && grep -q 'EnvironmentFile=/etc/claude-rpg.env' deploy/claude-rpg.service && echo "unit structure OK"
```
Expected: "unit structure OK".

- [ ] **Step 6: Commit**

```bash
git add deploy/claude-rpg.service deploy/claude-rpg.env.example scripts/pi/run-server.sh
git commit -m "feat(pi): server systemd unit, env template, run script"
```

---

## Task 2: Kiosk launch script + compositor autostart

**Files:**
- Create: `scripts/pi/kiosk.sh`, `deploy/labwc-autostart`, `deploy/wayfire-kiosk.ini`

- [ ] **Step 1: Create `scripts/pi/kiosk.sh`**

```bash
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
exec "$CHROME" \
  --kiosk \
  --app="$URL" \
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
```

- [ ] **Step 2: Create `deploy/labwc-autostart`** (copied to `~/.config/labwc/autostart`)

```bash
# ClaudeRPG kiosk (labwc autostart). __REPO__ replaced by setup.sh.
__REPO__/scripts/pi/kiosk.sh &
```

- [ ] **Step 3: Create `deploy/wayfire-kiosk.ini`** (fallback; merged into `~/.config/wayfire.ini`)

```ini
[autostart]
claude_rpg = __REPO__/scripts/pi/kiosk.sh
screensaver = false
dpms = false
```

- [ ] **Step 4: Make executable + syntax-check**

Run:
```bash
chmod +x scripts/pi/kiosk.sh
bash -n scripts/pi/kiosk.sh && echo "kiosk.sh: syntax OK"
command -v shellcheck >/dev/null && shellcheck scripts/pi/kiosk.sh || echo "(shellcheck skipped)"
```
Expected: "syntax OK".

- [ ] **Step 5: Commit**

```bash
git add scripts/pi/kiosk.sh deploy/labwc-autostart deploy/wayfire-kiosk.ini
git commit -m "feat(pi): Chromium kiosk launcher + compositor autostart"
```

---

## Task 3: Idempotent installer (`setup.sh`)

**Files:**
- Create: `scripts/pi/setup.sh`

This is the one command an operator runs on the Pi. It must be **idempotent** (safe to re-run) and print clear next steps.

- [ ] **Step 1: Create `scripts/pi/setup.sh`**

```bash
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
( cd "$REPO_DIR" && npm install --omit=dev=false )
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
echo "  TV:      http://claude-rpg.local:.../tv   (shown on the Pi's HDMI)"
```

- [ ] **Step 2: Make executable + lint**

Run:
```bash
chmod +x scripts/pi/setup.sh
bash -n scripts/pi/setup.sh && echo "setup.sh: syntax OK"
command -v shellcheck >/dev/null && shellcheck -S warning scripts/pi/setup.sh || echo "(shellcheck skipped)"
```
Expected: "syntax OK". If shellcheck is installed, fix any **error**-level findings (warnings about sudo/`cd` in subshells are acceptable; note them).

- [ ] **Step 3: Commit**

```bash
git add scripts/pi/setup.sh
git commit -m "feat(pi): idempotent kiosk installer"
```

---

## Task 4: Uninstaller + operator guide

**Files:**
- Create: `scripts/pi/uninstall.sh`, `docs/PI_SETUP.md`

- [ ] **Step 1: Create `scripts/pi/uninstall.sh`**

```bash
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
```

- [ ] **Step 2: Create `docs/PI_SETUP.md`**

````markdown
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
````

- [ ] **Step 3: Make executable + syntax-check**

Run:
```bash
chmod +x scripts/pi/uninstall.sh
bash -n scripts/pi/uninstall.sh && echo "uninstall.sh: syntax OK"
```
Expected: "syntax OK".

- [ ] **Step 4: Commit**

```bash
git add scripts/pi/uninstall.sh docs/PI_SETUP.md
git commit -m "docs(pi): operator guide + uninstaller"
```

---

## Task 5: Final sweep + README pointer

**Files:**
- Modify: `README.md` (add a Pi deployment pointer)

- [ ] **Step 1: Syntax-check every shell script and confirm the app is untouched**

Run:
```bash
for f in scripts/pi/*.sh; do bash -n "$f" && echo "$f OK"; done
command -v shellcheck >/dev/null && shellcheck scripts/pi/*.sh || echo "(shellcheck not installed)"
npm test && npm run typecheck
```
Expected: all scripts "OK"; the full suite green (125) and typecheck clean (no `src/` changes were made).

- [ ] **Step 2: Add a deployment pointer to `README.md`**

Add this section near the top of `README.md` (after the intro, before "Plan A"):

```markdown
## Run it on a Raspberry Pi 5 (TV kiosk)

To deploy as an unattended office TV display (auto-start server + Chromium kiosk
on `/tv`, reachable at `claude-rpg.local`), see **[docs/PI_SETUP.md](docs/PI_SETUP.md)**:
clone the repo on the Pi and run `bash scripts/pi/setup.sh`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: point README at the Pi kiosk setup guide"
```

- [ ] **Step 4: Report** that off-Pi automated checks pass (syntax + suite green) and that the **on-Pi verification checklist in `PI_SETUP.md` is the real acceptance test** — to be run by the human on the actual hardware.

---

## Self-Review

**Spec coverage (§10 Pi deployment):**
- Auto-login on boot → Task 3 (desktop autologin via `raspi-config nonint do_boot_behaviour B4`). ✅
- Server starts on boot, restarts, survives reboot → Task 1 (systemd `Restart=always`, `WantedBy=multi-user.target`). ✅
- Chromium kiosk to `localhost/tv`, no keyboard/mouse interaction → Task 2 (`kiosk.sh --kiosk --app`). ✅
- Reachable from a laptop; admin over LAN; players' snippet host → Task 3 (hostname `claude-rpg` + Avahi → `claude-rpg.local`, matching the snippet's default `OTEL_ENDPOINT_HOST`). ✅
- Power-loss durability → already in Plan C (SQLite); verified by the checklist. ✅
- Setup script + README → Tasks 3, 4, 5. ✅
- Screen-blanking disabled for an always-on TV → Task 2 (xset/swayidle + compositor flags). ✅

**Out of scope:** the cosmetic art-curation pass (creature ladder / tile manifest) the user deferred — best done on the real TV but not required for deployment. An SSE heartbeat is unnecessary here (Chromium talks to localhost with no proxy).

**Placeholder scan:** `__USER__`/`__REPO__` are intentional templates filled by `setup.sh` via `sed` — not unfinished work. No TBDs.

**Honesty about testing:** every shell script is `bash -n`-checked (and shellchecked when available) and the unit/desktop files are structurally validated, but **none of systemd/Chromium/labwc/Avahi can be exercised on the dev machine**. The authoritative acceptance test is the on-Pi checklist in `PI_SETUP.md`. The plan makes no claim that the kiosk "works" from off-Pi checks alone — it claims the artifacts are syntactically valid, structurally correct, and complete.

**Consistency:** `PORT`/`ADMIN_PASSWORD`/`SESSION_SECRET`/`OTEL_ENDPOINT_HOST`/`DB_PATH`/`SPRITES_DIR` in `claude-rpg.env.example` match `src/config.ts`'s env names exactly. `OTEL_ENDPOINT_HOST=claude-rpg.local` matches both the Pi hostname set by `setup.sh` and the snippet default from Plan A. `run-server.sh` uses `npm start` (the project's existing script → `tsx src/index.ts`). No `src/` changes, so the 125-test suite and typecheck are unaffected.
