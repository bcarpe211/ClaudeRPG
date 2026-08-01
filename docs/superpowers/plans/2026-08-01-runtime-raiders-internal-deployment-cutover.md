# Runtime Raiders Internal Deployment and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and execute one reversible, internal-only Runtime Raiders cutover that preserves the production database, changes scoring exactly once, and never deploys while the dungeon is active.

**Architecture:** DNS, TLS, Caddy compatibility, and Pi mDNS are prepared before the application release. A read-only preflight and rehearsed runbook gate a coordinated idle window in which the updater is held, the database is backed up, the new release and environment are installed together, and companions are enabled only after server and UI verification; rollback restores the recorded server version and pre-cutover database.

**Tech Stack:** Raspberry Pi OS, systemd, Caddy with Cloudflare DNS-01, mDNS/Avahi, SQLite, Bash, Node/TypeScript app, Chromium kiosk, macOS Runtime Raiders companion

## Global Constraints

- `clauderpg.redlattice.com` is an internally facing address and is not an internet-exposed service.
- Target internal DNS is `raiders.redlattice.com`; IT must create it.
- Current Pi mDNS is `claude-rpg.local`; target Pi mDNS is `raiders.local`.
- Caddy serves the new name and retains the old host temporarily as a compatibility alias.
- No step creates public ingress; Cloudflare DNS-01 certificate issuance is not public application exposure.
- Keep the existing repository path, SQLite filename, `claude-rpg.service`, environment filename, and auto-update unit during this compatibility-first release.
- Never deploy unless `game_state.paused = 1` and remains paused at the final check.
- Monday is the earliest target, not a deadline. Any failed gate reschedules the launch without a partial cutover.
- Existing history is preserved; no progression reset is permitted.
- The single cutover timestamp rejects Runs that began earlier and divides legacy OTLP scoring from Runtime Raiders scoring.
- Old Claude OTel configuration is removed manually; the companion may diagnose it but never edits provider/shell configuration.
- Do not push, SSH, change DNS, restart services, change the Pi hostname, or touch production until the user explicitly authorizes that exact stage.
- Source plans: collector/scoring and product rebrand dated 2026-08-01.

## File map

- `deploy/Caddyfile`: new internal hostname plus temporary old-host compatibility.
- `deploy/claude-rpg.env.example`: target Runtime Raiders URL, scoring mode, cutover, and policy configuration while retaining the compatibility filename.
- `scripts/pi/setup.sh`: target `raiders` mDNS hostname for fresh/reconfigured Pis while retaining service/repo names.
- `scripts/pi/runtime-raiders-preflight.sh`: read-only, fail-closed readiness report.
- `docs/PI_SETUP.md`: current Runtime Raiders operations with explicit compatibility identifiers.
- `docs/RUNTIME_RAIDERS_CUTOVER.md`: exact preparation, launch, verification, abort, and rollback runbook.
- `tests/deploy-runtime-raiders.test.ts`: static deployment/configuration safety tests.

---

### Task 1: Prepare dual-host Caddy and target runtime configuration

**Files:**
- Modify: `deploy/Caddyfile`
- Modify: `deploy/claude-rpg.env.example`
- Create: `tests/deploy-runtime-raiders.test.ts`

**Interfaces:**
- Produces Caddy sites: `raiders.redlattice.com` and `clauderpg.redlattice.com` to the same `localhost:8080` app.
- Produces env keys: `PUBLIC_URL`, `SCORING_MODE`, `RUN_SCORING_CUTOVER_AT`, `RAID_POWER_POLICY_PATH`.
- Preserves: `PORT`, `DB_PATH`, `SPRITES_DIR`, admin/session config, compatibility filenames, and service name.

- [ ] **Step 1: Write deployment-file tests**

```ts
expect(caddy).toContain('raiders.redlattice.com');
expect(caddy).toContain('clauderpg.redlattice.com');
expect(caddy).toContain('reverse_proxy localhost:8080');
expect(env).toContain('PUBLIC_URL=https://raiders.redlattice.com');
expect(env).toContain('SCORING_MODE=runtime-raiders');
expect(env).toContain('RUN_SCORING_CUTOVER_AT=');
expect(env).toContain('RAID_POWER_POLICY_PATH=');
```

Also assert there is no `0.0.0.0`, public tunnel, Cloudflare Tunnel, port-forward,
or new public listener configuration.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/deploy-runtime-raiders.test.ts`

- [ ] **Step 3: Add the new Caddy hostname compatibly**

Use one site block with both hostnames, the existing reverse proxy, encoding,
Cloudflare DNS-01, and resolver behavior. Update comments to Runtime Raiders and
state that both records resolve internally. Do not remove the old hostname.

- [ ] **Step 4: Add target environment keys**

The example targets Runtime Raiders mode and requires an explicit millisecond
cutover timestamp and absolute checked-in policy path. Keep `DB_PATH` pointing to
the existing database. Remove `OTEL_ENDPOINT_HOST` from active configuration;
the legacy server mode derives no new player setup snippet after rebrand.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/deploy-runtime-raiders.test.ts tests/config.test.ts`

```bash
git add deploy/Caddyfile deploy/claude-rpg.env.example tests/deploy-runtime-raiders.test.ts
git commit -m "ops(raiders): prepare internal dual-host configuration"
```

### Task 2: Prepare the `raiders.local` Pi hostname without renaming services

**Files:**
- Modify: `scripts/pi/setup.sh`
- Modify: `deploy/claude-rpg.service`
- Modify: `deploy/labwc-autostart`
- Modify: `docs/PI_SETUP.md`
- Modify: `tests/deploy-runtime-raiders.test.ts`

**Interfaces:**
- Changes fresh/reconfiguration hostname target to `raiders`.
- Preserves `claude-rpg.service`, `/etc/claude-rpg.env`, repo path, database path, updater unit names, and localhost kiosk URL.

- [ ] **Step 1: Extend tests for the compatibility boundary**

Assert `HOSTNAME_WANT="raiders"`, setup output mentions `raiders.local`, service
and env compatibility names remain, and kiosk still opens `localhost:<port>/tv`.

- [ ] **Step 2: Update scripts, service description, and setup guide**

Change visible comments/descriptions to Runtime Raiders. Add an explicit note to
`PI_SETUP.md`:

```text
Compatibility identifiers intentionally retained for this release:
/home/rluser/ClaudeRPG, data/claude-rpg.db, /etc/claude-rpg.env,
claude-rpg.service, and claude-rpg-autoupdate.*
```

Document both internal DNS and mDNS access. Do not imply that either makes the
service public.

- [ ] **Step 3: Syntax-check, test, and commit**

Run: `bash -n scripts/pi/setup.sh scripts/pi/kiosk.sh scripts/pi/run-server.sh scripts/pi/auto-update.sh`

Run: `npm test -- tests/deploy-runtime-raiders.test.ts`

```bash
git add scripts/pi/setup.sh deploy/claude-rpg.service deploy/labwc-autostart docs/PI_SETUP.md tests/deploy-runtime-raiders.test.ts
git commit -m "ops(raiders): target raiders local hostname"
```

### Task 3: Add a read-only, fail-closed Pi preflight

**Files:**
- Create: `scripts/pi/runtime-raiders-preflight.sh`
- Create: `tests/runtime-raiders-preflight.test.ts`

**Interfaces:**
- Produces: `runtime-raiders-preflight.sh --db PATH --env PATH --repo PATH`.
- Exit 0 means ready for a separately authorized cutover; any unknown/error exits nonzero.
- Performs no write, restart, package install, Git mutation, hostname change, or database migration.

- [ ] **Step 1: Write tests with fake commands and temporary files**

Cover missing DB/env/policy, `paused=0`, missing cutover, scoring mode mismatch,
dirty tree, diverged Git state, failed new-host HTTPS, failed old-host HTTPS,
invalid Caddy config, inactive server, and a fully ready result. Assert the
script contains no `systemctl restart`, `hostnamectl set-hostname`, `git pull`,
`sqlite3 .restore`, `rm`, or env-file write.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/runtime-raiders-preflight.test.ts`

- [ ] **Step 3: Implement explicit checks**

The report prints PASS/FAIL for:

1. exact repo and DB paths;
2. readable SQLite with `PRAGMA integrity_check = ok`;
3. `game_state.paused = 1`;
4. clean Git worktree and fast-forwardable target commit;
5. valid Runtime Raiders env candidate and policy file;
6. Caddy validation;
7. HTTPS health through new and old internal names;
8. current/target hostname resolution;
9. server/updater unit state; and
10. free disk space for two full DB backups plus release files.

Never print secrets or the full environment.

- [ ] **Step 4: Verify and commit**

Run: `bash -n scripts/pi/runtime-raiders-preflight.sh`

Run: `npm test -- tests/runtime-raiders-preflight.test.ts`

```bash
git add scripts/pi/runtime-raiders-preflight.sh tests/runtime-raiders-preflight.test.ts
git commit -m "ops(raiders): add fail-closed cutover preflight"
```

### Task 4: Write and rehearse the complete cutover/rollback runbook

**Files:**
- Create: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Create: `tests/runtime-raiders-runbook.test.ts`

**Interfaces:**
- Produces a human-driven runbook; it does not automate destructive restore or external coordination.
- Requires recorded values: prior SHA, release SHA, backup path, cutover timestamp, policy version, DNS/TLS evidence, and user approval.

- [ ] **Step 1: Write runbook completeness tests**

Assert the document contains exact gates for IT DNS, Caddy/TLS, mDNS, paused
state, backup verification, migration rehearsal, auto-updater hold, old OTel
cleanup, three-provider canaries, scoring-mode exclusivity, kiosk validation,
rollback triggers, and explicit no-go wording.

- [ ] **Step 2: Draft the preparation section**

Preparation occurs before launch day and changes no scoring:

1. IT creates internal `raiders.redlattice.com`.
2. Caddy adds/validates the new name while retaining the old.
3. The Pi changes to `raiders.local`; verify SSH/mDNS on the actual Internet
   Sharing/office path and verify the kiosk still uses localhost.
4. Build/sign/notarize companion and complete all canaries.
5. Rehearse migration against a SQLite backup copy and compare retained state.
6. Prepare, but do not yet install, the final env file.

- [ ] **Step 3: Draft the coordinated cutover section**

After explicit user approval and a final `paused=1` check:

```text
stop/disable the auto-update timer temporarily
record prior SHA and current environment checksum
create a SQLite .backup with timestamp and verify integrity
stop the game service
fast-forward to the approved release SHA and run npm ci if lockfile changed
install the reviewed env with one cutover timestamp and Runtime Raiders mode
start the service and wait for /health
verify schema, retained Raider totals, policy version, and old OTLP no-op
verify landing, Raider Hub, TV, Leaderboard, new/old HTTPS, mDNS, and SSE version
enable canary companions, run Codex/Claude/Omp, then enable the office
restore the auto-update timer only after acceptance
```

The service stays stopped between old code and the complete new configuration,
so users never see a mixed rebrand/scoring state.

- [ ] **Step 4: Draft rollback triggers and exact order**

Rollback triggers include migration/startup failure, lost history, double score,
content leakage, provider interference, wrong scoring mode/policy, unavailable
new host, broken kiosk, or canary mismatch. The order is:

```text
raiders off on every enabled canary/office Mac
hold auto-updater
stop game service
move the failed post-cutover DB aside without deleting it
restore the verified pre-cutover DB backup
switch the clean Pi checkout to the recorded prior SHA
restore the prior environment and start the service
verify health, DB integrity, old host, kiosk, and prior SSE SHA
leave Runtime Raiders disabled and investigate offline
```

State clearly that post-cutover Raid Power is lost on rollback and is not rebuilt
from Mac outboxes.

- [ ] **Step 5: Rehearse entirely on temporary local files**

Copy a production-shaped fixture to a new `/private/tmp` directory, apply the
release migration, compare every retained player/progression/economy table,
simulate the three provider events, then restore the untouched backup and prove
its checksum and rows match the start. Never point rehearsal commands at
`data/claude-rpg.db`.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/runtime-raiders-runbook.test.ts tests/db-runtime-raiders-migration.test.ts tests/runtime-raiders-e2e.test.ts`

```bash
git add docs/RUNTIME_RAIDERS_CUTOVER.md tests/runtime-raiders-runbook.test.ts
git commit -m "docs(raiders): define reversible internal cutover"
```

### Task 5: Complete the external DNS, TLS, and mDNS gates

**Files:**
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md` only to record non-secret evidence and dates.

**Interfaces:**
- Consumes completed IT/Caddy/Pi coordination.
- Produces verified internal reachability before application cutover.

- [ ] **Step 1: Stop and request authorization for external changes**

Do not proceed on assumed permission. The user coordinates IT DNS and separately
authorizes Caddy/Pi changes.

- [ ] **Step 2: Verify IT DNS from an office Mac**

Confirm `raiders.redlattice.com` resolves to the intended internally facing IP
on the office resolver. Record only hostname, expected IP, resolver class, and
date; do not claim public exposure from DNS-01 behavior.

- [ ] **Step 3: Install and validate the dual-host Caddy file on the Pi**

Run Caddy validation before reload, reload rather than stop/start, then verify
valid TLS and `/health` through both internal hostnames. Any failure leaves the
old configuration active and blocks later steps.

- [ ] **Step 4: Change and verify the Pi hostname**

Use `hostnamectl set-hostname raiders` only after recording the current hostname
and with user authorization. Reboot if required, then verify `raiders.local`,
SSH, Avahi, server service, local kiosk, and both DNS HTTPS names on the actual
network path.

- [ ] **Step 5: Record the external gate**

Commit only the evidence checklist update; never commit IPs, Cloudflare tokens,
credentials, or certificate private material.

```bash
git add docs/RUNTIME_RAIDERS_CUTOVER.md
git commit -m "docs(raiders): record internal network readiness"
```

### Task 6: Prepare off-state Mac companions and remove legacy OTel safely

**Files:**
- Modify: `docs/runtime-raiders/canary-checklist.md`
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`

**Interfaces:**
- Consumes the signed companion artifact and successful test-server canaries.
- Produces office Macs installed with collection off and no active legacy OTel scoring configuration.

- [ ] **Step 1: Enroll canary Macs against the staging/local test server**

Use the one-line installer, immediately run `raiders off`, then `raiders status`
and `raiders doctor`. Verify no provider config, workspace, command history, or
provider-owned file changed.

- [ ] **Step 2: Inventory legacy Claude OTel settings manually**

On each participating Mac, check the current shell environment and the known
shell configuration block previously used by ClaudeRPG. Record only present/
absent, never the contents of unrelated shell configuration.

- [ ] **Step 3: Remove only the known ClaudeRPG OTel block**

The player or administrator edits the exact old block manually, starts a fresh
shell, and confirms the old variables are absent. The Runtime Raiders installer
and companion do not perform this edit.

- [ ] **Step 4: Verify providers still operate normally with Raiders off**

Run a harmless canary in Codex, Claude Code, and Omp. Confirm no old OTLP metric
changes production, no Runtime Raiders event uploads, and each tool behaves
normally.

- [ ] **Step 5: Record readiness without enabling scoring**

Do not turn companions on. Commit only the content-free canary matrix.

### Task 7: Execute the single idle production cutover

**Files:**
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md` with final evidence only.

**Interfaces:**
- Consumes all prior plans and gates.
- Produces the live internal Runtime Raiders release or a verified rollback.

- [ ] **Step 1: Stop and request explicit push/deployment authorization**

Present the release SHA, automated results, visual approval, provider canaries,
policy report, DNS/TLS/mDNS status, current `game_state.paused`, backup target,
cutover timestamp, and rollback SHA. No authorization means no push or Pi action.

- [ ] **Step 2: Re-run the read-only preflight immediately before launch**

Expected: every line PASS and `game_state.paused = 1`. If the dungeon wakes or
any result is unknown/failing, abort and reschedule.

- [ ] **Step 3: Execute the runbook exactly**

Hold the updater, back up and verify the DB, keep the server down while release
and environment change together, start once in Runtime Raiders mode, and do not
enable any companion until retained state, mode, policy, routes, UI, kiosk, and
old OTLP no-op are verified.

- [ ] **Step 4: Enable canaries, then the office**

Run one controlled Codex, Claude Code, and Omp Run. Verify expected Run Details,
Raid Power, additive concurrency, no duplicate score, `total_tokens` unchanged,
and content-free payload evidence. Only then have all players run `raiders on`.

- [ ] **Step 5: Observe and close or roll back**

Watch at least one complete Fight plus a long Run, parallel Runs, a client
restart, and a brief server-unavailable retry. On any rollback trigger, execute
rollback immediately. Otherwise restore the updater timer and record the live
SSE release SHA, policy version, cutover time, and verification results.

- [ ] **Step 6: Commit the content-free deployment record**

```bash
git add docs/RUNTIME_RAIDERS_CUTOVER.md docs/runtime-raiders/canary-checklist.md
git commit -m "docs(raiders): record internal cutover verification"
```

The old hostname remains temporarily compatible after launch. Retiring it,
renaming the repository/service/database/environment identifiers, and performing
the comprehensive internal rewrite require their own later design and migration.
