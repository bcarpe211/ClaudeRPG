# Runtime Raiders internal cutover and rollback

This is the human-driven procedure for the first internal Runtime Raiders
release. It preserves the production SQLite database, changes scoring once, and
keeps `clauderpg.redlattice.com` as a compatibility name. It does not authorize
DNS, Caddy, Pi, service, companion, or office changes by itself.

The dungeon may be resting; the safety gates are not. A failed, unknown, stale,
or incomplete gate is a **NO-GO**. Leave the current service unchanged and
reschedule. Never improvise a partial rebrand or mixed scoring deployment.

## Authority and operating boundaries

Each boundary needs its own explicit authorization. Approval for one row does
not authorize another.

| Boundary | Required owner/approval | What is not implied |
| --- | --- | --- |
| Internal `raiders.redlattice.com` DNS | IT | Public ingress or public DNS |
| Caddy config/reload and Pi hostname | User-approved Pi administrator | Application cutover |
| Fetching or publishing a release/artifact | Repository/release owner | Pi deployment or office activation |
| Production cutover and rollback | Explicit user approval for the recorded release and window | Future deployments |
| Companion install and old OTel cleanup | Mac owner or authorized administrator | Editing provider configuration |
| Enabling canaries, then the office | Explicit canary/office activation approval | Enabling any unverified provider |

Cloudflare DNS-01 certificate issuance does not make the application public.
Both FQDNs and `raiders.local` remain internal access paths. Do not push, fetch,
publish, SSH, change DNS/Caddy/hostname, operate services, touch the production
database, or message office users until the owner has authorized that exact
stage.

The companion collects only approved, content-free Run metadata. Evidence from
this procedure may contain counts, status, timestamps, policy version, and
release SHAs only. Never report prompts, responses, commands, tool content or
arguments, source contents, project names, local/native IDs, local provider
paths, credentials, enrollment codes, tokens, shell configuration contents, or
provider configuration.

## Record of truth

Create one restricted operator record outside the repository and fill every
value before requesting cutover approval. Do not put secrets, internal IPs,
certificate material, or environment contents in this document or a commit.

| Required value | Exact recorded value/evidence |
| --- | --- |
| Operator and UTC window | `________________` |
| Prior full 40-character SHA (`PRIOR_SHA`) | `________________` |
| Approved release full 40-character SHA (`RELEASE_SHA`) | `________________` |
| Prior/release short SSE versions | `________________ / ________________` |
| One 13-digit millisecond epoch (`CUTOVER_AT`) and UTC rendering | `________________ / ________________` |
| Policy version | `1` |
| Production DB path | `/home/rluser/ClaudeRPG/data/claude-rpg.db` |
| Verified pre-cutover `.backup` path (`DB_BACKUP`) | `________________` |
| Production DB owner, group, and mode | `________________` |
| Prior root-owned environment backup path | `________________` |
| Prior environment SHA-256 | `________________` |
| Candidate environment path and SHA-256 | `________________` |
| Manager-loaded Caddy config and env paths | `________________ / ________________` |
| IT DNS evidence/date for both FQDNs | `________________` |
| Caddy validation and TLS evidence/date for both FQDNs | `________________` |
| `raiders.local`, SSH, Avahi, actual network-path evidence/date | `________________` |
| Signed/notarized companion artifact checksum and canary record | `________________` |
| Migration/e2e/preflight/config test evidence | `________________` |
| Exact user authorization and UTC timestamp | `________________` |
| Final decision: accepted, aborted, or rolled back | `________________` |

Use these compatibility paths and names throughout:

```sh
REPO=/home/rluser/ClaudeRPG
DB=/home/rluser/ClaudeRPG/data/claude-rpg.db
CURRENT_ENV=/etc/claude-rpg.env
CANDIDATE_ENV=/etc/claude-rpg.env.runtime-raiders-candidate
SERVICE=claude-rpg.service
UPDATER_TIMER=claude-rpg-autoupdate.timer
UPDATER_SERVICE=claude-rpg-autoupdate.service
```

In the operator shell, set `PRIOR_SHA`, `RELEASE_SHA`, `CUTOVER_AT`,
`CADDY_CONFIG`, and `CADDY_ENV` to the recorded literal values. Do not derive or
change them during the cutover. Confirm that both SHAs contain exactly 40
lowercase hexadecimal characters, are distinct, and that `CUTOVER_AT` contains
exactly 13 decimal digits. Record the output of:

```sh
git --no-optional-locks -C "$REPO" rev-parse --short "$PRIOR_SHA"
git --no-optional-locks -C "$REPO" rev-parse --short "$RELEASE_SHA"
date -u -d "@$((CUTOVER_AT / 1000))" '+%Y-%m-%dT%H:%M:%SZ'
```

## 1. Preparation: complete before launch day

Preparation does not change scoring. Any external preparation still needs the
matching authorization above.

### 1.1 Internal DNS and Caddy/TLS

- IT creates internal `raiders.redlattice.com` for the intended Pi address.
  Verify it through the actual office resolver. Keep the IP in the restricted
  operator record, not in Git.
- The active Caddy site must contain exactly
  `raiders.redlattice.com, clauderpg.redlattice.com`, proxy only to
  `localhost:8080`, and retain the existing Cloudflare DNS-01/public-resolver
  behavior. Validate before an authorized reload; failure leaves the old config
  active and blocks launch.
- Verify valid TLS and `GET /health` through both internal FQDNs. This is not an
  internet exposure test.
- Record the active inputs that the service manager actually loaded; do not
  assume `/etc/caddy/Caddyfile` or an environment path:

  ```sh
  systemctl show caddy.service --property=ExecStart --value
  systemctl show caddy.service --property=EnvironmentFiles --value
  ```

  Set `CADDY_CONFIG` to the sole `--config` argument and `CADDY_ENV` to the sole
  required environment file. The active service must use those exact paths.
  `CADDY_ENV` must be a nonsymlink regular file owned by root with mode `0600`.
  The candidate game environment has the same root/`0600` requirement. Never
  print either file or any secret from it.

### 1.2 Pi hostname, mDNS, and kiosk

- With separately authorized Pi access, change the static hostname to
  `raiders`, keep Avahi active, and verify that `raiders.local` resolves to one
  of this Pi's own IPv4 addresses.
- Verify SSH and mDNS on the actual Internet Sharing and office paths that Macs
  will use. A result from a different network path is not evidence for launch.
- Verify the Chromium kiosk still opens `http://localhost:8080/tv`; do not
  replace that loopback URL with DNS or mDNS.
- Verify `claude-rpg.service`, `/etc/claude-rpg.env`,
  `/home/rluser/ClaudeRPG`, `data/claude-rpg.db`, and
  `claude-rpg-autoupdate.*` remain the active compatibility identifiers.

### 1.3 Companion, provider, privacy, and old OTel gates

- Build, sign, notarize, staple, and validate the universal companion with
  `scripts/release/build-runtime-raiders-agent.sh` as documented in
  `docs/runtime-raiders/companion-operations.md`. Publication is a separate
  authorized action. Record the artifact checksum, signature/notarization
  result, and date, never signing credentials.
- Install authorized canaries with collection immediately set to off. Run
  `raiders off`, `raiders status`, and `raiders doctor`. Complete the signed
  artifact and deployed/Pi canary rows in
  `docs/runtime-raiders/canary-checklist.md` before launch.
- The exact initial allowlist is
  `RUN_ENABLED_SURFACES=codex_desktop,codex_cli`. Both Codex Desktop and Codex
  CLI need controlled canaries. `claude_code` and `omp` are disabled and
  unsupported: do not scan their roots, accept their events, infer their
  activity, or use process/window/history/hook/telemetry fallbacks.
- The Mac owner or authorized administrator manually removes only the known old
  ClaudeRPG OTel shell block, starts a fresh shell, and records present/absent
  status only. Confirm these legacy variables are absent:
  `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`,
  `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_METRIC_EXPORT_INTERVAL`,
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, and
  `OTEL_RESOURCE_ATTRIBUTES`. The installer and companion never edit shell or
  provider configuration.
- With Raiders off, run harmless Codex Desktop and CLI canaries. Confirm both
  work normally, no Runtime Raiders upload occurs, old OTLP causes no production
  change, and `raiders status` lists Claude Code and Omp as unavailable without
  probing them.

### 1.4 Safe migration and scoring rehearsal

Run rehearsal only in a clean release checkout on a development machine. These
existing suites create disposable synthetic fixtures under the system temporary
directory; they do not use the production database, a Pi, DNS, Caddy, services,
or live providers:

```sh
npm test -- tests/db-runtime-raiders-migration.test.ts \
  tests/runtime-raiders-e2e.test.ts \
  tests/runtime-raiders-preflight.test.ts \
  tests/config.test.ts
```

The migration fixture starts from populated pre-Runtime-Raiders SQLite state,
applies the real additive migration through `openDb`, and compares retained
player activity and possessions in `players`, `token_events`,
`player_inventory`, `gold_ledger`, `player_cosmetics`, and
`player_slot_cosmetics`. The e2e fixture exercises Codex Desktop and CLI events,
deduplication, retained legacy totals/economy/progression, and atomic rejection
of Claude, Omp, mismatched, and mixed-surface batches. The preflight suite runs
only temporary repositories, databases, protected env fixtures, fake system
boundaries, and local HTTPS fakes. Never aim a rehearsal command at
`data/claude-rpg.db` or copy production data into the repository.

### 1.5 Prepare, but do not install, the final environment

Create the reviewed candidate at `CANDIDATE_ENV`; do not replace
`CURRENT_ENV`. It must be a nonsymlink regular file owned by root with exact mode
`0600`, use the existing absolute DB and sprite paths, contain strong non-shipped
admin/session secrets, and contain exactly one unquoted `KEY=value` assignment
for every required key. It must include:

```text
PORT=8080
DB_PATH=/home/rluser/ClaudeRPG/data/claude-rpg.db
SPRITES_DIR=/home/rluser/ClaudeRPG/assets/oryx_16-bit_fantasy_1.1/Sliced
PUBLIC_URL=https://raiders.redlattice.com
SCORING_MODE=runtime-raiders
RUN_SCORING_CUTOVER_AT=<the one recorded CUTOVER_AT>
RAID_POWER_POLICY_PATH=/home/rluser/ClaudeRPG/config/raid-power-policy-v1.json
RUN_ENABLED_SURFACES=codex_desktop,codex_cli
```

It must not contain `OTEL_ENDPOINT_HOST`. Do not install the checked-in
`1800000000000` placeholder. Record only the candidate file's SHA-256 and
metadata, never its contents:

```sh
sudo chown root:root "$CANDIDATE_ENV"
sudo chmod 0600 "$CANDIDATE_ENV"
sudo stat -c '%U %G %a %n' "$CANDIDATE_ENV"
sudo sha256sum "$CANDIDATE_ENV"
```

## 2. Hold the updater, then run the read-only preflight

Holding systemd units is a state change and requires Pi authorization. Do it
before preflight; the hardened preflight deliberately fails immediately unless
the timer is disabled and inactive and the already-launched oneshot is inactive.

```sh
sudo systemctl disable --now "$UPDATER_TIMER"
sudo systemctl stop "$UPDATER_SERVICE"
systemctl is-enabled "$UPDATER_TIMER"   # exact result: disabled
systemctl is-active "$UPDATER_TIMER"    # exact result: inactive
systemctl is-active "$UPDATER_SERVICE"  # exact result: inactive
```

Do not start the cutover yet. While deployed `HEAD` still equals `PRIOR_SHA`,
run the approved release's script directly from its Git object. `origin/main`
must already resolve to the exact `RELEASE_SHA`; the preflight never fetches,
checks out, installs, writes configuration, migrates, or changes service state.

```sh
set -o pipefail
git --no-optional-locks -C "$REPO" show \
  "$RELEASE_SHA:scripts/pi/runtime-raiders-preflight.sh" |
  sudo env \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0="$REPO" \
    bash -s -- \
    --db "$DB" \
    --env "$CANDIDATE_ENV" \
    --repo "$REPO" \
    --prior-sha "$PRIOR_SHA" \
    --release-sha "$RELEASE_SHA" \
    --cutover-at "$CUTOVER_AT" \
    --caddy-config "$CADDY_CONFIG" \
    --caddy-env "$CADDY_ENV"
```

Proceed only if the command exits 0, every named gate says `PASS`, and the final
line is exactly `READY separately authorized cutover gates passed`. In
particular, confirm both initial and final updater holds, initial and final Git
readiness, active manager-loaded Caddy inputs, root/`0600` env protection,
internal DNS for both FQDNs, pinned HTTPS for both FQDNs, exact `raiders.local`
identity, active server/Caddy/Avahi, disk capacity for two logical DB snapshots
plus release files, database integrity, exact environment/policy/allowlist, and
the **final** `game_state.paused = 1` read.

Preflight is a read-only readiness observation, not authorization. Any elapsed
window, repository change, updater state change, Caddy/env change, DNS/mDNS
change, service change, or game wake makes the result stale: stop and rerun it.

## 3. Explicit authorization or NO-GO

Present the completed record of truth, fresh preflight result, test evidence,
visual approval, signed canary evidence, exact prior/release SHAs, exact backup
target, policy version `1`, exact `CUTOVER_AT`, DNS/TLS/mDNS evidence, current
`paused=1`, rollback order, and post-rollback loss semantics to the user.

The user must explicitly authorize this release SHA, timestamp, backup target,
and cutover window. Record the approval and UTC time. Silence, staging approval,
a target day, earlier authorization, or preflight success is **not** cutover
authorization.

NO-GO and reschedule if any value is missing; any gate is failed, unknown,
pending, or stale; the game is not paused; the updater is not fully held; the
checkout is dirty/diverged; signing, canaries, old OTel cleanup, internal DNS,
TLS, mDNS, kiosk, migration rehearsal, backup capacity, or visual approval is
incomplete; or explicit user authorization is absent. Restore the updater timer
only if the operator intentionally returns to normal prior-release operation.

## 4. Coordinated cutover

Use one operator and one shell. Announce the maintenance window. Companions and
office collection stay off. Do not enable a companion anywhere in this section.

### 4.1 Reconfirm identity, pause, and updater hold

```sh
test "$(git --no-optional-locks -C "$REPO" rev-parse HEAD)" = "$PRIOR_SHA"
test -z "$(git --no-optional-locks -C "$REPO" status --porcelain)"
test "$(git --no-optional-locks -C "$REPO" rev-parse origin/main)" = "$RELEASE_SHA"
test "$(systemctl is-enabled "$UPDATER_TIMER")" = disabled
test "$(systemctl is-active "$UPDATER_TIMER")" = inactive
test "$(systemctl is-active "$UPDATER_SERVICE")" = inactive
test "$(sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT paused FROM game_state WHERE id=1;')" = 1
```

Any failure is an abort. Do not continue on a cached pause result.

### 4.2 Record the prior state and create the verified backup

Choose one UTC `CUTOVER_ID` for artifact filenames. Record the literal paths as
`DB_BACKUP`, `PRIOR_ENV_BACKUP`, and `RETAINED_BEFORE` in the restricted record.
The example directory is root-readable only:

```sh
CUTOVER_ID=$(date -u '+%Y%m%dT%H%M%SZ')
BACKUP_DIR=/var/backups/runtime-raiders/$CUTOVER_ID
DB_BACKUP=$BACKUP_DIR/claude-rpg.pre-cutover.db
PRIOR_ENV_BACKUP=$BACKUP_DIR/claude-rpg.env.pre-cutover
RETAINED_SQL=$BACKUP_DIR/retained-check.sql
RETAINED_BEFORE=$BACKUP_DIR/retained-before.tsv
DB_OWNER=$(stat -c '%U' "$DB")
DB_GROUP=$(stat -c '%G' "$DB")
DB_MODE=$(stat -c '%a' "$DB")
sudo install -d -o root -g root -m 0700 "$BACKUP_DIR"

git --no-optional-locks -C "$REPO" rev-parse HEAD
sudo sha256sum "$CURRENT_ENV"
sudo install -o root -g root -m 0600 "$CURRENT_ENV" "$PRIOR_ENV_BACKUP"
sudo sqlite3 "$DB" ".timeout 10000" ".backup '$DB_BACKUP'"
sudo chown root:root "$DB_BACKUP"
sudo chmod 0600 "$DB_BACKUP"
sudo sqlite3 -readonly "$DB_BACKUP" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;'
sudo sha256sum "$DB_BACKUP"
```

The integrity result must be exactly `ok`. A file copy of the live SQLite main
file is not a backup: `.backup` is required so committed WAL state is included.

Capture retained aggregates without authentication tokens or content. Save the
exact query beside the backup so the acceptance check cannot drift:

```sh
sudo tee "$RETAINED_SQL" >/dev/null <<'SQL'
PRAGMA query_only=ON;
SELECT 'players', count(*), total(level), total(total_tokens),
       total(effective_tokens), total(gold), total(peak_modifier) FROM players;
SELECT 'token_events', count(*), total(effective_delta), total(total_delta)
  FROM token_events;
SELECT 'settings', count(*) FROM settings;
SELECT 'metric_series', count(*) FROM metric_series;
SELECT 'metric_deliveries', count(*) FROM metric_deliveries;
SELECT 'dungeons', count(*) FROM dungeons;
SELECT 'level_ups', count(*) FROM level_ups;
SELECT 'encounters', count(*) FROM encounters;
SELECT 'encounter_damage', count(*), total(damage_total) FROM encounter_damage;
SELECT 'monster_attacks', count(*) FROM monster_attacks;
SELECT 'game_state', count(*), total(paused), total(combat_active_ms)
  FROM game_state;
SELECT 'game_clock_days', count(*) FROM game_clock_days;
SELECT 'player_daily_combat', count(*) FROM player_daily_combat;
SELECT 'inventory', count(*), total(quantity) FROM player_inventory;
SELECT 'inventory_lots', count(*), total(remaining_quantity)
  FROM player_inventory_lots;
SELECT 'shop_purchases', count(*), total(quantity), total(total_price)
  FROM shop_purchases;
SELECT 'potion_activations', count(*) FROM potion_activations;
SELECT 'potion_work_events', count(*), total(effective_delta)
  FROM potion_work_events;
SELECT 'potion_activation_encounters', count(*)
  FROM potion_activation_encounters;
SELECT 'encounter_reward_awards', count(*) FROM encounter_reward_awards;
SELECT 'gold_ledger', count(*), total(amount) FROM gold_ledger;
SELECT 'player_cosmetics', count(*) FROM player_cosmetics;
SELECT 'player_slot_cosmetics', count(*) FROM player_slot_cosmetics;
SELECT 'player_slot_cosmetic_revisions', count(*)
  FROM player_slot_cosmetic_revisions;
SELECT 'player_cosmetic_mutation_sessions', count(*)
  FROM player_cosmetic_mutation_sessions;
SELECT 'player_slot_cosmetic_batches', count(*)
  FROM player_slot_cosmetic_batches;
SQL
sudo chown root:root "$RETAINED_SQL"
sudo chmod 0600 "$RETAINED_SQL"
sudo sqlite3 -readonly -separator $'\t' "$DB_BACKUP" \
  ".read $RETAINED_SQL" >"/tmp/retained-before.tsv"
sudo install -o root -g root -m 0600 /tmp/retained-before.tsv "$RETAINED_BEFORE"
sudo rm /tmp/retained-before.tsv
sudo sha256sum "$RETAINED_BEFORE"
```

If any query or backup check fails, abort before stopping the service.

### 4.3 Stop at the mixed-state boundary

```sh
sudo systemctl stop "$SERVICE"
test "$(systemctl is-active "$SERVICE")" = inactive
```

From this point until the new checkout, dependencies, reviewed environment, and
migration-on-start are all complete, the service stays stopped. Never expose old
code with the new environment or new code with the old environment.

### 4.4 Install the exact release and environment while stopped

```sh
git --no-optional-locks -C "$REPO" merge --ff-only "$RELEASE_SHA"
test "$(git --no-optional-locks -C "$REPO" rev-parse HEAD)" = "$RELEASE_SHA"

if ! git --no-optional-locks -C "$REPO" diff --quiet \
  "$PRIOR_SHA" "$RELEASE_SHA" -- package-lock.json; then
  (cd "$REPO" && npm ci)
fi

sudo install -o root -g root -m 0600 "$CANDIDATE_ENV" "$CURRENT_ENV"
sudo stat -c '%U %G %a %n' "$CURRENT_ENV"
sudo sha256sum "$CURRENT_ENV"
```

The installed SHA-256 must equal the reviewed candidate SHA-256. Confirm exactly
one cutover timestamp, `SCORING_MODE=runtime-raiders`, exact
`codex_desktop,codex_cli`, policy path/version `1`, existing DB/sprite paths,
strong secrets, and no `OTEL_ENDPOINT_HOST`. Do not print the environment.

### 4.5 Start once and wait for migration/health

`openDb` applies the additive migration at service start; there is no separate
production migration command.

```sh
sudo systemctl start "$SERVICE"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://localhost:8080/health >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 2 http://localhost:8080/health
test "$(systemctl is-active "$SERVICE")" = active
sudo sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;'
sudo sqlite3 -readonly "$DB" \
  "PRAGMA query_only=ON; SELECT id FROM _migrations WHERE id='019_runtime_raiders_runs';"
```

Expected results are `{"ok":true}`, `active`, `ok`, and
`019_runtime_raiders_runs`. A timeout, restart loop, migration error, integrity
error, or missing schema marker triggers rollback; do not repeatedly restart.

## 5. Acceptance before any companion is enabled

### 5.1 Retained state, mode, policy, and old OTLP no-op

Generate the retained aggregate with the saved query; the byte comparison must
succeed:

```sh
RETAINED_AFTER=$BACKUP_DIR/retained-after.tsv
sudo sqlite3 -readonly -separator $'\t' "$DB" \
  ".read $RETAINED_SQL" >"/tmp/retained-after.tsv"
sudo install -o root -g root -m 0600 /tmp/retained-after.tsv "$RETAINED_AFTER"
sudo rm /tmp/retained-after.tsv
sudo cmp -s "$RETAINED_BEFORE" "$RETAINED_AFTER"
LEGACY_TOTAL_TOKENS_BEFORE=$(sudo sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT total(total_tokens) FROM players;')
```

Existing level, lifetime Raid Power baseline
(`players.effective_tokens`), token history, gold, damage, cosmetics, inventory,
potions, and progression must not reset or drift.

Before/after counts around this compatibility request must match, and the HTTP
result must be `200` with `{}`:

```sh
OTLP_ROWS_BEFORE=$(sudo sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT count(*) FROM token_events;')
curl -fsS --max-time 5 -H 'content-type: application/json' \
  --data '{}' https://raiders.redlattice.com/v1/metrics
OTLP_ROWS_AFTER=$(sudo sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT count(*) FROM token_events;')
test "$OTLP_ROWS_BEFORE" = "$OTLP_ROWS_AFTER"

test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' --data '{"events":[]}' \
  https://raiders.redlattice.com/api/runs/events)" = 401
```

The unauthenticated Run-route `401` distinguishes active Runtime Raiders mode
from the fail-closed `503 scoring_disabled` response. The executable config,
metrics, and e2e tests are the evidence that scoring modes are mutually
exclusive and realistic old OTLP input is acknowledged without writing.

After controlled canaries, every new `runs.policy_version` must be `1`, all Run
starts must be at or after `CUTOVER_AT`, and `players.total_tokens` must remain
at its retained baseline. Do not rewrite existing lifetime state.

### 5.2 Routes, TLS, mDNS, kiosk, Leaderboard, and release version

From the Pi, the actual office path, and the TV as appropriate, verify:

- `/`, `/character`, `/tv`, and `/tv/stream` through
  `https://raiders.redlattice.com`;
- `/health` through both `https://raiders.redlattice.com` and the compatibility
  `https://clauderpg.redlattice.com`, with valid TLS;
- `http://raiders.local:8080/health` and SSH/mDNS on the actual office/Internet
  Sharing path;
- the physical kiosk still uses `http://localhost:8080/tv`, fills the screen,
  receives live SSE state, and shows the dungeon and rotating Leaderboard;
- one existing Raider can open Raider Hub and sees the retained level, Raid
  Power, gold, inventory, potions, and cosmetics; and
- the first `/tv/stream` `version` event equals the recorded short
  `RELEASE_SHA`. The server uses `git rev-parse --short HEAD` for this marker.

Record pass/fail and UTC time only. Do not record a Raider Key, page content, or
SSE state payload.

## 6. Canary activation, office activation, and acceptance

Only after section 5 passes may the activation owner enable canaries.

1. On one approved canary, run `raiders status`, then `raiders on`.
2. Run one harmless Codex Desktop Run and one Codex CLI Run that both begin
   after `CUTOVER_AT`. Record only aggregate status/count/timestamp.
3. Verify one Run per surface, expected version-1 Raid Power, additive parallel
   Runs, idempotent duplicate delivery, no double score, unchanged
   `players.total_tokens`, correct Raider Hub/Run Details, and content-free
   payload evidence.
4. Run `raiders status` and confirm exactly Codex Desktop and Codex CLI are
   enabled. Claude Code and Omp remain unavailable and are not scanned.
   Existing temporary-fixture e2e evidence must show synthetic Claude, Omp,
   mismatched-provider, and mixed-surface batches rejected atomically with
   `surface_disabled` and no progression mutation.
5. Observe a complete Fight, one long Run, parallel Runs, a collector restart,
   and a brief server-unavailable retry. Confirm outbox replay is idempotent and
   content-free.
6. If every canary and observation passes, request and record separate office
   activation approval. Have participating users run `raiders on`.

Use content-free database aggregates to check the server-side canary boundary:

```sh
test "$(sudo sqlite3 -readonly "$DB" \
  "PRAGMA query_only=ON; SELECT count(*) FROM runs
   WHERE started_at_ms < $CUTOVER_AT OR policy_version <> '1';")" = 0
test "$(sudo sqlite3 -readonly "$DB" \
  "PRAGMA query_only=ON; SELECT count(*) FROM runs
   WHERE provider <> 'codex'
      OR surface NOT IN ('codex_desktop','codex_cli');")" = 0
sudo sqlite3 -readonly "$DB" \
  "PRAGMA query_only=ON;
   SELECT surface, count(*), total(raid_power)
   FROM runs GROUP BY surface ORDER BY surface;"
test "$(sudo sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT total(total_tokens) FROM players;')" = \
  "$LEGACY_TOTAL_TOKENS_BEFORE"
```

The grouped output must contain only `codex_cli` and `codex_desktop`, with the
expected canary counts. The legacy lifetime token total must remain unchanged.

Any mismatch triggers section 7 immediately. Do not broaden
`RUN_ENABLED_SURFACES`, change policy, or enable Claude/Omp to work around it.

After canary and office acceptance, restore the updater timer and verify the
oneshot is not already running:

```sh
sudo systemctl enable --now "$UPDATER_TIMER"
test "$(systemctl is-enabled "$UPDATER_TIMER")" = enabled
test "$(systemctl is-active "$UPDATER_TIMER")" = active
test "$(systemctl is-active "$UPDATER_SERVICE")" = inactive
```

Record the final SSE release SHA, policy version `1`, exact `CUTOVER_AT`, test
results, UI/kiosk/network results, canary counts, user acceptance, and UTC time.
The temporary old FQDN remains compatible. Retiring it or renaming the repo,
database, env, service, or updater identifiers is a separate migration.

## 7. Rollback

### 7.1 Immediate triggers

Rollback immediately for any migration or startup failure/restart loop;
database integrity failure; missing or changed history; reset/drifted Raider
progression, economy, inventory, cosmetics, or Raid Power baseline; double
score; accepted pre-cutover Run; content leakage; provider interference or
provider-config change; Claude/Omp activity; wrong scoring mode, allowlist,
cutover, or policy; old OTLP changing score; unavailable new internal host or
invalid TLS; broken mDNS/SSH path; broken physical kiosk/Leaderboard/SSE; canary
mismatch; non-idempotent outbox replay; or any unknown acceptance result.

### 7.2 Exact rollback order

Do not attempt a destructive reverse migration. Use the recorded verified
backup and prior SHA.

1. **Turn collection off first.** On every enabled canary and office Mac, run
   `raiders off`, then confirm `raiders status` is off. This is external
   coordination; do not continue enabling or asking clients to replay.
2. **Hold the updater.** Disable/stop the timer, stop the updater oneshot, and
   verify timer disabled/inactive and service inactive exactly as in section 2.
3. **Stop the game service.** Run `sudo systemctl stop "$SERVICE"` and require
   `inactive`.
4. **Preserve the failed post-cutover database without deleting it.** With the
   service stopped, move the DB and any WAL/SHM sidecars into a new root-only
   incident directory:

   ```sh
   FAILED_DIR=/var/backups/runtime-raiders/$CUTOVER_ID/failed-post-cutover
   sudo install -d -o root -g root -m 0700 "$FAILED_DIR"
   sudo mv "$DB" "$FAILED_DIR/claude-rpg.failed.db"
   if sudo test -e "$DB-wal"; then
     sudo mv "$DB-wal" "$FAILED_DIR/claude-rpg.failed.db-wal"
   fi
   if sudo test -e "$DB-shm"; then
     sudo mv "$DB-shm" "$FAILED_DIR/claude-rpg.failed.db-shm"
   fi
   ```

5. **Restore the verified pre-cutover DB.** Recheck the recorded backup checksum
   and integrity, restore it, reapply the recorded DB owner/group/mode, and
   verify the result as the service user:

   ```sh
   sudo sha256sum "$DB_BACKUP"
   sudo sqlite3 -readonly "$DB_BACKUP" \
     'PRAGMA query_only=ON; PRAGMA integrity_check;'
   sudo sqlite3 "$DB" ".restore '$DB_BACKUP'"
   sudo chown "$DB_OWNER:$DB_GROUP" "$DB"
   sudo chmod "$DB_MODE" "$DB"
   sudo -u rluser sqlite3 -readonly "$DB" \
     'PRAGMA query_only=ON; PRAGMA integrity_check;'
   ```

   Both integrity results must be exactly `ok`.
6. **Switch the clean checkout to the recorded prior SHA.** The updater remains
   held. Require an otherwise clean checkout, echo the exact target, then move
   `main` back deliberately:

   ```sh
   test -z "$(git --no-optional-locks -C "$REPO" status --porcelain)"
   printf 'rollback target: %s\n' "$PRIOR_SHA"
   git -C "$REPO" reset --hard "$PRIOR_SHA"
   test "$(git --no-optional-locks -C "$REPO" rev-parse HEAD)" = "$PRIOR_SHA"
   if ! git --no-optional-locks -C "$REPO" diff --quiet \
     "$PRIOR_SHA" "$RELEASE_SHA" -- package-lock.json; then
     (cd "$REPO" && npm ci)
   fi
   ```

7. **Restore the prior environment and start.** Copy only the recorded root
   `0600` backup, verify its recorded checksum without printing it, start once,
   and wait for local health:

   ```sh
   sudo sha256sum "$PRIOR_ENV_BACKUP"
   sudo install -o root -g root -m 0600 "$PRIOR_ENV_BACKUP" "$CURRENT_ENV"
   sudo systemctl start "$SERVICE"
   curl -fsS --retry 30 --retry-delay 2 --retry-connrefused \
     http://localhost:8080/health
   ```

8. **Verify prior operation.** Require active service, DB integrity, retained
   pre-cutover aggregates, old internal HTTPS host, physical localhost kiosk and
   Leaderboard, and a `/tv/stream` version event equal to the recorded short
   `PRIOR_SHA`. The new host may remain as a harmless Caddy compatibility name;
   the restored prior application is the authority.
9. **Leave Runtime Raiders disabled.** Keep all companions off and the updater
   timer disabled. Record the rollback and investigate only with copies of the
   failed DB, logs, and synthetic/offline fixtures. Any later retry requires a
   new record, fresh backup, fresh preflight, and new explicit authorization.

### 7.3 Loss semantics after rollback

Rollback restores the pre-cutover database exactly. Therefore **all Raid Power,
Runs, Run events, enrollment/device state, and any other game mutations created
after cutover are lost from the active service**. They remain only in the
preserved failed post-cutover database for offline investigation.

Do not rebuild post-cutover Raid Power from Mac outboxes, do not replay queued
events into the restored database, and do not merge the failed DB into
production during the incident. Companions remain off until a separately
designed reconciliation or a newly authorized clean cutover decides how to
handle their local queues.

## 8. Closeout checklist

- [ ] Every preparation gate has owner, UTC date, and pass evidence.
- [ ] Prior/release SHAs, short SSE versions, one cutover timestamp, policy
      version, backup path/checksum, env checksums, Caddy inputs, and explicit
      user approval are recorded.
- [ ] Updater timer and oneshot were held before preflight and throughout
      cutover.
- [ ] Fresh preflight ended READY with a final paused read.
- [ ] Logical `.backup` integrity and retained-state baseline were verified.
- [ ] Service stayed stopped across checkout/dependencies/env installation.
- [ ] Migration, integrity, retained state, scoring exclusivity, policy,
      routes, both FQDNs, mDNS, physical kiosk, Leaderboard, and SSE SHA passed.
- [ ] Old OTel is removed manually; no content or secrets were reported.
- [ ] Only Codex Desktop and Codex CLI canaries passed; Claude Code and Omp
      stayed disabled and rejected.
- [ ] Office activation occurred only after separate approval and canary
      acceptance.
- [ ] Updater was restored only after acceptance, or remained held after
      abort/rollback.
- [ ] Final status is accepted, aborted, or rolled back, with loss semantics
      acknowledged.
