# TV auto-reload on new deploy — design

**Date:** 2026-07-14
**Backlog:** #19 (kiosk self-heal; follow-on to the Pi auto-updater)

## Problem

The Pi kiosk (`scripts/pi/kiosk.sh`) opens Chromium on `/tv` **once at boot** and
never reloads it. The auto-updater (`scripts/pi/auto-update.sh`) pulls new code and
`systemctl restart claude-rpg` — restarting the **server** only. The `/tv` client
(`src/web/public/tv/tv.js`) opens an `EventSource('/tv/stream')` with no reload
handling, so after a deploy the browser silently reconnects the SSE stream and keeps
running whatever `tv.js`/`index.html` it loaded at boot.

Result: the server can be fully up to date while the TV renders old client code —
observed live as the TV showing the pre-rotation leaderboard even though the Pi
server was already on the commit that ships it.

## Goal

The `/tv` kiosk reloads itself when the server it is connected to has been redeployed
to a new commit, so a deploy propagates to the screen without a manual reboot.

## Key insight

A server restart does **not** tear down the browser page — only the `EventSource`
disconnects and auto-reconnects. So a JS variable on the page survives the restart
and can be compared against what the reconnected (new) server reports.

## Design

### 1. Server version — `src/version.ts` (new)
At module load, resolve the deployed commit once:
`execSync('git rev-parse --short HEAD', { cwd: <repo root> })`, trimmed. Wrapped in
try/catch; on any failure (not a repo / git missing / detached) fall back to the
process start timestamp (`Date.now().toString(36)`), which still yields a distinct
value per process. Exported as `export const SERVER_VERSION: string`. Computed once
per process, so it is stable within a server lifetime and changes only when a restart
lands on different code.

Repo root: derive from the module URL (`fileURLToPath(import.meta.url)` → up to the
project root) rather than `process.cwd()`, so it is correct regardless of the
launching cwd. The systemd unit does set `WorkingDirectory`, but deriving from the
module keeps it robust in dev/tests.

### 2. Server → client — `src/web/tvhub.ts`
In `TvHub.addClient`, before the `layout`/`state`/`leaderboards` frames, write a
`version` frame: `client.write(frame('version', SERVER_VERSION))`. Sent on **every**
connection, including SSE reconnects. Import `SERVER_VERSION` from `../version`.

### 3. Client — `src/web/public/tv/tv.js`
Add one SSE listener next to the existing ones:
```js
let bootVersion = null;
evt.addEventListener('version', (e) => {
  const v = JSON.parse(e.data);
  if (bootVersion === null) bootVersion = v;      // baseline for this page-load
  else if (v !== bootVersion) location.reload();  // server redeployed → refresh
});
```
No reload loop: after `location.reload()`, the fresh page's first `version` event
becomes its new baseline. If the SSE briefly drops and reconnects to the **same**
server, the version matches and nothing happens.

## Scope / non-goals

- `/tv` only (the long-lived kiosk page). Human-visited pages refresh naturally.
- No change to `kiosk.sh` or the auto-updater — no fragile window-manager key
  injection. The reload is driven entirely by the app.
- One-time bootstrap: the currently-stale TV page predates this logic, so it needs a
  single manual reload (a Pi reboot) to pick up the new `tv.js`. Self-healing after.

## Testing

- `SERVER_VERSION` is a non-empty string (unit).
- `TvHub.addClient` writes a `version` frame on connect, before `state` (hub test —
  a fake client records the frames; assert a `event: version` frame is present).
- The 3-line `tv.js` reload path is browser code (not currently unit-tested; `tv.js`
  is canvas rendering). Covered by the hub test + manual verification note; low risk.

## Risk

- If git is unavailable at startup, the timestamp fallback means every restart looks
  like a new version → the TV reloads on any restart. Acceptable (deploys are
  idle-gated; the Pi is a git checkout so the SHA path is the normal case).
