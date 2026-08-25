# Runtime Raiders internal cutover and rollback

> **Historical pre-0.4.0 procedure.** The sequence-based companion release and
> cutover workflow below is retired and must not be run. The current companion
> procedure is
> [`docs/runtime-raiders/employee-beta.md`](runtime-raiders/employee-beta.md).

This is the human-driven procedure for the first internal Runtime Raiders
release. It preserves the production SQLite database, changes scoring once, and
keeps `clauderpg.redlattice.com` as a compatibility name. It does not authorize
DNS, Caddy, Pi, service, companion, or office changes by itself.

The dungeon may be resting; the safety gates are not. A failed, unknown, stale,
or incomplete gate is a **NO-GO**. Leave the current service unchanged and
reschedule. Never improvise a partial rebrand or mixed scoring deployment.

Sequence 1 is withdrawn and consumed. Preserve it as immutable evidence; never
reuse, reselect, modify, delete, or repackage it. The authoritative companion
release contract is [`docs/runtime-raiders/companion-operations.md`](runtime-raiders/companion-operations.md).
The recovery lifecycle is Caddy preparation → sequence-2 publication →
installed-off sequence-2 canary → sequence-3 build/review/signing → sequence-3
publication → notification/status proof → manual `raiders update` → bounded
`raiders on` proof → `raiders off` → separate office activation. No step
authorizes the next.

## Authority and operating boundaries

Each boundary needs its own explicit authorization. Approval for one row does
not authorize another.

| Boundary | Required owner/approval | What is not implied |
| --- | --- | --- |
| Internal `raiders.redlattice.com` DNS | IT | Public ingress or public DNS |
| Caddy config/reload and Pi hostname | User-approved Pi administrator | Application cutover |
| Holding the updater | User-approved Pi administrator | Publishing, fetching, or deploying a release |
| Publishing/fetching the approved SHA to tracked `origin/main` | Repository/release owner, after verified updater hold | Pi checkout, service start, or future SHAs |
| Preparing fail-closed Caddy artifact routes | User-approved Pi administrator, after exact release publication | Artifact publication, application cutover, or companion installation |
| Production cutover and rollback | Explicit user approval for the recorded release and window | Future deployments |
| Publishing the signed companion quartet | Explicit release-owner approval after section 5 server acceptance | Installing, enabling, updating, or office activation |
| Companion install and old OTel cleanup | Mac owner or authorized administrator | Editing provider configuration or enabling collection |
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

## Current preparation status

Every mutable production, network-path, final-build, and installed-companion
observation is pending fresh verification against the final `RELEASE_SHA`.
Approved design and local test evidence dated 2026-08-03 or earlier may support
preparation, but does not authorize or prove a later operational gate.

## Record of truth

Create one restricted operator record outside the repository. Fill every
pre-cutover value before requesting cutover approval; explicitly post-cutover
publication and canary fields remain blank until their separately authorized
boundary is reached. Do not put secrets, internal IPs, certificate material, or
environment contents in this document or a commit.

| Required value | Exact recorded value/evidence |
| --- | --- |
| Operator and UTC window | `________________` |
| Prior full 40-character SHA (`PRIOR_SHA`) | `________________` |
| Approved release full 40-character SHA (`RELEASE_SHA`) | `________________` |
| Prior/release short SSE versions | `________________ / ________________` |
| One 13-digit millisecond epoch (`CUTOVER_AT`) and UTC rendering | `________________ / ________________` |
| Persisted policy key / JSON document version | `raid-power-v1` / `1` |
| One 13-digit millisecond v2 epoch (`RAID_POWER_V2_CUTOVER_AT`) and UTC rendering | `________________ / ________________` |
| v2 policy key / JSON document version | `raid-power-v2` / `2` |
| Production DB path | `/home/rluser/ClaudeRPG/data/claude-rpg.db` |
| Verified pre-cutover `.backup` path (`DB_BACKUP`) | `________________` |
| SHA-256 of the verified pre-cutover backup (`DB_BACKUP_SHA256`) | `________________` |
| Production DB owner, group, and mode | `________________` |
| Prior root-owned environment backup path | `________________` |
| Prior environment SHA-256 | `________________` |
| Retained-query and pre-cutover aggregate paths | `________________ / ________________` |
| Cutover ID and root-only backup directory | `________________ / ________________` |
| Root-only rollback record and detached seal paths | `________________ / ________________` |
| Independently copied expected rollback-record SHA-256 (`EXPECTED_ROLLBACK_RECORD_SHA256`) | `________________` |
| Candidate environment path and SHA-256 | `________________` |
| Manager-loaded Caddy config and env paths | `________________ / ________________` |
| Prior Caddy config backup path and SHA-256 | `________________ / ________________` |
| Artifact root | `/var/lib/runtime-raiders` |
| Manager-loaded game-unit verification evidence | `________________` |
| IT DNS evidence/date for both FQDNs | `________________` |
| Caddy validation and TLS evidence/date for both FQDNs | `________________` |
| `raiders.local`, SSH, Avahi, actual network-path evidence/date | `________________` |
| Signed quartet SHA-256 values, `companion/RELEASE`, and pre-cutover validation | `________________` |
| Post-cutover publication and installed-off canary record | `________________` |
| Migration/e2e/preflight/config test evidence | `________________` |
| Exact user authorization and UTC timestamp | `________________` |
| Final decision: accepted, aborted, or rolled back | `________________` |
| Final updater timer/oneshot state | `________________` |

Before the service is stopped, the root-only rollback record must contain every
rollback-required literal below. The field names are part of the contract; do
not abbreviate or reconstruct any value during an incident.

| Rollback record group | Required literal fields |
| --- | --- |
| Version and identity | `ROLLBACK_RECORD_VERSION`, `PRIOR_SHA`, `RELEASE_SHA`, `CUTOVER_ID` |
| Fixed production paths | `REPO`, `DB`, `CURRENT_ENV` |
| Fixed unit names | `SERVICE`, `UPDATER_TIMER`, `UPDATER_SERVICE` |
| Backup paths | `BACKUP_DIR`, `DB_BACKUP`, `PRIOR_ENV_BACKUP`, `RETAINED_SQL`, `RETAINED_BEFORE` |
| Backup checksums | `DB_BACKUP_SHA256`, `PRIOR_ENV_SHA256` |
| Database metadata | `DB_OWNER`, `DB_GROUP`, `DB_MODE` |
| Unit contract | `GAME_EXEC_PATH` |
| Record identity | `ROLLBACK_RECORD`, `ROLLBACK_RECORD_SEAL`, `ROLLBACK_GUARDS` |

Use these compatibility paths and names throughout:

```sh
REPO=/home/rluser/ClaudeRPG
DB=/home/rluser/ClaudeRPG/data/claude-rpg.db
CURRENT_ENV=/etc/claude-rpg.env
CANDIDATE_ENV=/etc/claude-rpg.env.runtime-raiders-candidate
ARTIFACT_ROOT=/var/lib/runtime-raiders
SERVICE=claude-rpg.service
UPDATER_TIMER=claude-rpg-autoupdate.timer
UPDATER_SERVICE=claude-rpg-autoupdate.service
GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh
```

In the operator shell, set `PRIOR_SHA`, `RELEASE_SHA`, `CUTOVER_AT`,
`CANDIDATE_ENV_SHA256`, `CADDY_CONFIG`, `CADDY_ENV`, and
`CADDY_BACKUP` to the recorded literal values. Do not derive or change them
during the cutover. Confirm that both SHAs contain exactly 40 lowercase
hexadecimal characters, are distinct, and that `CUTOVER_AT` contains exactly
13 decimal digits. Record the output of:

```sh
git --no-optional-locks -C "$REPO" rev-parse --short "$PRIOR_SHA"
git --no-optional-locks -C "$REPO" rev-parse --short "$RELEASE_SHA"
date -u -d "@$((CUTOVER_AT / 1000))" '+%Y-%m-%dT%H:%M:%SZ'
```

The systemd `start_time`, `stop_time`, `pid`, `code`, and `status` values are
observations, not identity fields. The executable helper verifies the stable
`GAME_EXEC_PATH` unit identity without authenticating a mutable full `ExecStart`
rendering.

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
  `claude-rpg-autoupdate.*` remain the active compatibility identifiers. Record
  and mechanically verify the manager-loaded game-service contract rather than
  trusting the unit file on disk:

  Source the release-pinned helper before this check, as shown in section 4,
  then run:

  ```sh
  rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
  ```

  Any mismatch blocks publication and cutover.

### 1.3 Companion, provider, privacy, and old OTel gates

- Build, sign, notarize, staple, and validate the universal companion with
  `scripts/release/build-runtime-raiders-agent.sh` as documented in
  `docs/runtime-raiders/companion-operations.md`. Publication is a separate
  authorized action. Record separate SHA-256 values for the rendered installer,
  ZIP, and checksum file plus the signature/notarization result and date, never
  signing credentials.
- Before cutover, require the exact signed-artifact validation, full automated
  server and companion suites, and fake-transport privacy evidence. Do not
  install the production-locked companion yet: its installer, download, and
  enrollment URLs intentionally cannot succeed until the Runtime Raiders server
  has passed section 5 and the signed quartet has been separately published.
  An installed canary is therefore a **post-cutover, pre-activation** gate, not
  a prerequisite for changing the server while every collector is absent.
- Implement and test the fail-closed publication mechanism before freezing the
  final `RELEASE_SHA`, then rebuild and revalidate the signed quartet from that
  final candidate. Keep the files unpublished until section 5.3.
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
RAID_POWER_POLICY_V2_PATH=/home/rluser/ClaudeRPG/config/raid-power-policy-v2.json
RAID_POWER_V2_CUTOVER_AT=<the separately recorded v2 cutoff>
RUN_ENABLED_SURFACES=codex_desktop,codex_cli
```

It must not contain `OTEL_ENDPOINT_HOST`. Do not install the checked-in
`1800000000000` placeholders. Record only the candidate file's SHA-256 and
metadata, never its contents:

```sh
sudo chown root:root "$CANDIDATE_ENV"
sudo chmod 0600 "$CANDIDATE_ENV"
sudo stat -c '%U %G %a %n' "$CANDIDATE_ENV"
sudo sha256sum "$CANDIDATE_ENV"
```

## 2. Ordered pre-cutover authority gates

### 2.1 Hold the updater before touching tracked `origin/main`

This ordering is an authorization boundary. The release owner must not publish
the candidate to tracked `main`, and the Pi must not fetch or update tracked
`origin/main`, until a Pi administrator has held and verified both updater
units. In a clean Bash shell, use strict mode and attempt every hold action even
if one fails:

```sh
set -Eeuo pipefail
UPDATER_GUARDS="$(mktemp)"
sudo -u rluser git --no-optional-locks -C "$REPO" show \
  "$RELEASE_SHA:scripts/pi/runtime-raiders-cutover-guards.sh" >"$UPDATER_GUARDS"
test -s "$UPDATER_GUARDS"
bash -n "$UPDATER_GUARDS"
# shellcheck source=/dev/null
source "$UPDATER_GUARDS"
hold_failed=0
sudo systemctl disable --now "$UPDATER_TIMER" || hold_failed=1
sudo systemctl stop "$UPDATER_SERVICE" || hold_failed=1
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE" || hold_failed=1
test "$hold_failed" = 0
```

Failure is a NO-GO; do not publish, fetch, prepare Caddy, or deploy anything.

### 2.2 Publish and fetch only the exact release SHA

After the exact hold has been recorded, the repository owner may separately
authorize publishing only `RELEASE_SHA` to `main`. Fetch the approved object
into the tracked remote ref as `rluser` using the literal SHA refspec, so a
moving or future `main` cannot enter the Pi checkout:

```sh
sudo -u rluser -H git -C "$REPO" fetch --no-tags origin \
  "$RELEASE_SHA:refs/remotes/origin/main"
FETCHED_RELEASE_SHA="$(sudo -u rluser git --no-optional-locks -C "$REPO" \
  rev-parse origin/main)"
test "$FETCHED_RELEASE_SHA" = "$RELEASE_SHA"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
```

Any fetch mismatch or failure is an abort and the updater remains held. Do not
restore it merely because cutover was cancelled. Exact repository publication
does not authorize Caddy preparation, preflight, checkout, or cutover.

### 2.3 Prepare the fail-closed Caddy routes

After exact release publication, obtain a separate Caddy-preparation approval.
Before changing the loaded config, record a root-only backup of
`CADDY_CONFIG` and its SHA-256 in the restricted operator record outside Git.
Do not print, copy into Git, or otherwise expose `CADDY_ENV`, its token, or any
environment contents.

Run the following as one transactional block. It creates only the empty fixed
release store, records the exact prior-config digest, and arms automatic
restoration before replacing the loaded config. The rollback path verifies the
recorded backup digest, restores and validates that exact config with the
manager-loaded environment, reloads Caddy, and rechecks both HTTPS health names.
It reports rollback trouble but always preserves the status that triggered the
rollback.

```sh
prepare_caddy_routes() (
  set -Eeuo pipefail
  umask 077

  REVIEWED_CADDY="$(mktemp)"
  case "$CADDY_BACKUP" in
    /var/backups/runtime-raiders/*/Caddyfile.before-artifacts) ;;
    *) false ;;
  esac
  sudo install -d -o root -g root -m 0700 "${CADDY_BACKUP%/*}"
  sudo install -o root -g root -m 0600 "$CADDY_CONFIG" "$CADDY_BACKUP"
  sudo test "$(sudo stat -c '%U:%G:%a' "$CADDY_BACKUP")" = root:root:600
  CADDY_BACKUP_SHA256="$(sudo sha256sum "$CADDY_BACKUP" | awk '{print $1}')"
  [[ "$CADDY_BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]]
  printf 'Record prior Caddy SHA-256 outside Git: %s\n' "$CADDY_BACKUP_SHA256"

  sudo -u rluser git --no-optional-locks -C "$REPO" show \
    "$RELEASE_SHA:deploy/Caddyfile" > "$REVIEWED_CADDY"

  restore_prior_caddy() {
    original_status=$1
    test "$original_status" -ne 0 || original_status=1
    trap - EXIT HUP INT TERM
    set +e
    rollback_status=0
    observed_backup_sha256="$(sudo sha256sum "$CADDY_BACKUP" | awk '{print $1}')" \
      || rollback_status=1
    test "$observed_backup_sha256" = "$CADDY_BACKUP_SHA256" || rollback_status=1
    sudo test "$(sudo stat -c '%U:%G:%a' "$CADDY_BACKUP")" = root:root:600 \
      || rollback_status=1
    if test "$rollback_status" = 0; then
      sudo install -o root -g root -m 0644 "$CADDY_BACKUP" "$CADDY_CONFIG" \
        || rollback_status=1
    fi
    if test "$rollback_status" = 0; then
      test "$(sudo sha256sum "$CADDY_CONFIG" | awk '{print $1}')" = \
        "$CADDY_BACKUP_SHA256" || rollback_status=1
    fi
    if test "$rollback_status" = 0; then
      sudo caddy validate --config "$CADDY_CONFIG" --adapter caddyfile \
        --envfile "$CADDY_ENV" || rollback_status=1
    fi
    if test "$rollback_status" = 0; then
      sudo systemctl reload caddy.service || rollback_status=1
    fi
    if test "$rollback_status" != 0; then
      sudo systemctl stop caddy.service || true
    fi
    test "$(systemctl is-active caddy.service)" = active || rollback_status=1
    for url in \
      https://raiders.redlattice.com/health \
      https://clauderpg.redlattice.com/health; do
      test "$(curl --silent --show-error --proto '=https' --max-redirs 0 \
        --connect-timeout 10 --max-time 30 --output /dev/null \
        --write-out '%{http_code}' "$url")" = 200 || rollback_status=1
    done
    test "$rollback_status" = 0 \
      || printf 'Caddy rollback verification failed; investigate immediately.\n' >&2
    rm -f "$REVIEWED_CADDY"
    exit "$original_status"
  }

  trap 'restore_prior_caddy $?' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  sudo install -d -o root -g root -m 0755 \
    /var/lib/runtime-raiders \
    /var/lib/runtime-raiders/releases
  sudo test ! -e /var/lib/runtime-raiders/current
  sudo test ! -L /var/lib/runtime-raiders/current

  sudo install -o root -g root -m 0644 "$REVIEWED_CADDY" "$CADDY_CONFIG"
  sudo caddy validate --config "$CADDY_CONFIG" --adapter caddyfile \
    --envfile "$CADDY_ENV"
  sudo systemctl reload caddy.service
  test "$(systemctl is-active caddy.service)" = active

  for url in \
    https://raiders.redlattice.com/health \
    https://clauderpg.redlattice.com/health; do
    test "$(curl --silent --show-error --proto '=https' --max-redirs 0 \
      --connect-timeout 10 --max-time 30 --output /dev/null \
      --write-out '%{http_code}' "$url")" = 200
  done
  for url in \
    https://raiders.redlattice.com/install.sh \
    https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip \
    https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256 \
    https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json; do
    test "$(curl --silent --show-error --proto '=https' --max-redirs 0 \
      --connect-timeout 10 --max-time 30 --output /dev/null \
      --write-out '%{http_code}' "$url")" = 404
  done
  test "$(systemctl is-active "$SERVICE")" = active
  test "$(curl --silent --show-error --max-redirs 0 --connect-timeout 10 \
    --max-time 30 --output /dev/null --write-out '%{http_code}' \
    http://localhost:8080/health)" = 200
  sudo test ! -e /var/lib/runtime-raiders/current
  sudo test ! -L /var/lib/runtime-raiders/current

  trap - EXIT HUP INT TERM
  rm -f "$REVIEWED_CADDY"
)
prepare_caddy_routes
```

Leave `current` absent and stop. Caddy preparation does not authorize artifact
publication or production cutover.

### 2.4 Run the final read-only preflight

Only after Caddy preparation passes, while deployed `HEAD` still equals
`PRIOR_SHA`, run the approved release's script directly from its Git object.
The preflight never fetches, checks out, installs, writes configuration,
migrates, or changes service state.

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
    --caddy-env "$CADDY_ENV" \
    --artifact-root /var/lib/runtime-raiders
```

Proceed only if the command exits 0, every named gate says `PASS`, and the final
line is exactly `READY separately authorized cutover gates passed`. In
particular, confirm both initial and final updater holds, initial and final Git
readiness, active manager-loaded Caddy inputs, root/`0600` env protection,
internal DNS for both FQDNs, pinned HTTPS for both FQDNs, exact `raiders.local`
identity, active server/Caddy/Avahi, the root-owned empty artifact store with
`current` absent and all four artifact URLs returning `404`, disk capacity for
two logical DB snapshots plus release files, database integrity, exact
environment/policy/allowlist, and the **final** `game_state.paused = 1` read.

Preflight is a read-only readiness observation, not authorization. Any elapsed
window, repository change, updater state change, Caddy/env change, DNS/mDNS
change, service change, or game wake makes the result stale: stop and rerun it.

## 3. Explicit authorization or NO-GO

Present the completed pre-cutover record of truth, fresh preflight result, test
evidence, visual approval, signed/notarized artifact validation, exact
prior/release SHAs, exact backup target, persisted policy key
`raid-power-v1`, JSON policy document version `1`, exact `CUTOVER_AT`,
DNS/TLS/mDNS evidence, current
`paused=1`, rollback order, and post-rollback loss semantics to the user.

The user must explicitly authorize this release SHA, timestamp, backup target,
and cutover window. Record the approval and UTC time. Silence, staging approval,
a target day, earlier authorization, or preflight success is **not** cutover
authorization.

NO-GO and reschedule if any required pre-cutover value is missing; any
pre-cutover gate is failed, unknown, pending, or stale; the game is not paused;
the updater is not fully held; the checkout is dirty/diverged; signing,
pre-cutover automated evidence, old OTel
cleanup, internal DNS, TLS, mDNS, kiosk, migration rehearsal, backup capacity,
or visual approval is incomplete; or explicit user authorization is absent.
The installed production companion is intentionally absent at this boundary.
An abort leaves both updater units held. Returning to normal prior-release
operation requires a separate recorded authorization, a verified
`HEAD=PRIOR_SHA`, and a pinned updater design; the current moving-`main` updater
is not safe to re-enable.

### 3.1 Scoring v2 release gate: separately authorized and collection-off

This gate applies only after an explicit authorization records the reviewed
`RELEASE_SHA`, exact backup target, UTC window, and a v2 cutoff. It is a server
configuration release gate, not a collection or canary authorization. Do not
choose a cutoff from this document: the release owner chooses one future,
13-digit millisecond epoch, records its UTC rendering as
`RAID_POWER_V2_CUTOVER_AT`, and confirms it is not earlier than
`RUN_SCORING_CUTOVER_AT`.

Perform the following order exactly, retaining every established ownership,
updater-hold, and rollback requirement in sections 3–5:

1. Choose and record the one v2 cutoff in the restricted operator record.
   Never use the checked-in `1800000000000` placeholder.
2. Run the read-only scoring comparison against an explicitly authorized,
   timestamped copy of the database—not the live database—and retain its JSON
   receipt with the release evidence:

   ```sh
   npm run audit:scoring-v2 -- --db "$AUTHORIZED_SNAPSHOT" \
     --v2-cutover "$RAID_POWER_V2_CUTOVER_AT"
   ```

3. Run the complete automated server suite and typecheck from the reviewed
   release checkout. Any failure is a NO-GO.
4. Prove the public TV state still reports `"paused":true` before the backup;
   record the URL, observation time, and response evidence without recording
   player or Run content. A local database read alone is insufficient for this
   gate.
5. Create and verify the timestamped logical SQLite backup using the existing
   section 4.2 procedure. A copied SQLite main file is not a substitute.
6. Install the reviewed source at the authorized `RELEASE_SHA` while the service
   is stopped, using section 4.4's checkout and ownership checks.
7. Change only these two environment assignments in the root-owned candidate
   environment; preserve all existing reviewed assignments and do not print or
   source the file:

   ```text
   RAID_POWER_POLICY_V2_PATH=/home/rluser/ClaudeRPG/config/raid-power-policy-v2.json
   RAID_POWER_V2_CUTOVER_AT=<the recorded v2 cutoff>
   ```

8. Validate that candidate without sourcing it:

   ```sh
   sudo "$REPO/scripts/pi/validate-runtime-raiders-env.sh" \
     --env-file "$CANDIDATE_ENV" --repo-dir "$REPO"
   ```

9. Install the validated candidate, restart once under section 4.5's fail-closed
   boundary, and do not retry a failed start.
10. Verify the public `/health` response and prove the deployed revision equals
    the recorded `RELEASE_SHA`; retain both results with the release evidence.

**STOP.** A successful v2 server release does not authorize any collection,
companion installation, `raiders on`, canary command, or office activation.
Those actions remain blocked until their own explicit authorization.

### 3.2 Presence-clock release gate: separately authorized and collection-off

This gate is documentation for a later authorized operation; it performs no
production action by itself. Use it only after the scoring-v2 candidate has
been independently reviewed and the owner has authorized the exact presence
candidate SHA, backup target, and deployment window. Deployment authorization
does not authorize collection or the canary.

Migration `020_raider_presence` creates only the empty
`raider_presence(player_id, last_run_activity_at)` projection. It contains no
backfill: applying it must not insert presence from existing Runs, events,
devices, `token_events`, or `players.last_token_at`, and it must not edit,
delete, merge, or retarget any account, Raider, enrollment, device, Run, score,
or other history row. Before canary collection, require both the migration
marker and an empty table; any row at this boundary is a NO-GO.

The presence-specific rollback is an application-code rollback. First prove
the canary is off, then return to the recorded prior reviewed application SHA
under the existing stopped-service, ownership, health, and version gates. Leave
the additive `020_raider_presence` migration marker and its table in place as
inert schema. Do not drop the table, reverse the migration, or restore the
pre-release database merely to remove it during an incident. Database
corruption or an account/history mismatch remains a separate section 7 rollback
trigger; an otherwise healthy unused presence table is not.

Perform the release boundary in this order:

1. Prove the public TV state reports `"paused":true` immediately before the
   backup. Record the public URL, UTC observation time, and content-free result;
   a database-only pause read is insufficient.
2. Create and integrity-check the timestamped logical SQLite `.backup` from
   section 4.2. Retain its recorded path and SHA-256 outside Git.
3. While the service is stopped, install only the independently reviewed
   presence candidate SHA and preserve the already reviewed scoring-v2
   environment.
4. Start once. Verify database integrity, migration marker
   `020_raider_presence`, zero pre-canary presence rows, public `/health`, and a
   public `/tv/stream` version equal to the reviewed candidate's short SHA.
   Reconfirm `"paused":true`. Any mismatch is a NO-GO; do not enable a canary.

STOP — collection remains off without separate approval

Only a new, explicitly recorded one-canary collection approval permits the
remaining acceptance steps:

5. Record the canary Raider's Raid Power baseline, then enable exactly one
   approved canary only long enough to deliver one fresh, newly accepted
   zero-credit opening event. Do not activate another Mac or the office. If the
   event does not arrive in the authorized window, turn the canary off and stop;
   do not retry by broadening collection.
6. Immediately after that one event—or after any error—run `raiders off` and
   prove collection is disabled. Keep it off for every remaining observation.
7. From content-free evidence, verify the event recorded server-receipt
   presence, the dungeon woke immediately, public `activeRaiders` includes the
   canary, the new Run award is zero, and the Raider's Raid Power remains at its
   recorded baseline.
8. Verify an exact duplicate delivery does not advance the stored presence
   timestamp or Raid Power. Do not create a second new event to prove this.
9. Measure from the original accepted receipt. Verify the dungeon remains awake
   through the configured 15-minute window, then sleeps just after that boundary
   with the canary absent from `activeRaiders`; the duplicate must not extend
   the deadline.
10. Record the migration, health, version, wake, unchanged-Raid-Power,
    duplicate, sleep, and verified-off evidence. Office activation,
    re-enrollment, and wider collection remain separately blocked.

## 4. Coordinated cutover

Use one operator and one shell. Announce the maintenance window. Companions and
office collection stay off. Do not enable a companion anywhere in this section.
Paste the state-changing sections into one clean Bash session, not line by line.
Install a fail-closed trap before the first cutover action; every error or
interrupt stops the game and reasserts the updater hold:

```sh
set -Eeuo pipefail
CUTOVER_GUARDS="$(mktemp)"
sudo -u rluser git --no-optional-locks -C "$REPO" show \
  "$RELEASE_SHA:scripts/pi/runtime-raiders-cutover-guards.sh" >"$CUTOVER_GUARDS"
test -s "$CUTOVER_GUARDS"
bash -n "$CUTOVER_GUARDS"
# shellcheck source=/dev/null
source "$CUTOVER_GUARDS"

fail_closed() {
  local rc="${1:-1}"
  local cleanup_failed=0
  local service_state=''
  test "$rc" -ne 0 || rc=1
  trap - ERR HUP INT TERM
  set +e
  sudo systemctl disable --now "$UPDATER_TIMER" >/dev/null 2>&1 || cleanup_failed=1
  sudo systemctl stop "$UPDATER_SERVICE" >/dev/null 2>&1 || cleanup_failed=1
  sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || cleanup_failed=1
  rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE" || cleanup_failed=1
  rr_observe_systemctl service_state is-active "$SERVICE" || cleanup_failed=1
  test "$service_state" = inactive || cleanup_failed=1
  if test "$cleanup_failed" = 0; then
    echo "FAIL-CLOSED: game stopped; updater held; investigate before rollback" >&2
  else
    echo "FAIL-CLOSED: safe state could not be verified; investigate before rollback" >&2
  fi
  exit "$rc"
}
trap 'fail_closed $?' ERR
trap 'fail_closed 130' HUP INT TERM

```

The sourced helper is read from the exact approved release object, not from the
mutable checkout. Its Git and privileged ownership probes use standalone
checked assignments, so a no-output command failure cannot be mistaken for a
clean checkout or an all-`rluser` tree.

### 4.1 Reconfirm identity, pause, and updater hold

```sh
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
rr_assert_owned_tree "$REPO"
rr_assert_checkout "$REPO" "$PRIOR_SHA" "$RELEASE_SHA"
test "$(sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; SELECT paused FROM game_state WHERE id=1;')" = 1
```

Any failure is an abort. Do not continue on a cached pause result.

### 4.2 Record the prior state and create the verified backup

Choose one UTC `CUTOVER_ID` for artifact filenames. Record the literal paths as
`DB_BACKUP`, `PRIOR_ENV_BACKUP`, and `RETAINED_BEFORE` in the restricted record.
The example directory is root-readable only:

```sh
ROLLBACK_RECORD_VERSION=2
CUTOVER_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
BACKUP_DIR=/var/backups/runtime-raiders/$CUTOVER_ID
DB_BACKUP=$BACKUP_DIR/claude-rpg.pre-cutover.db
PRIOR_ENV_BACKUP=$BACKUP_DIR/claude-rpg.env.pre-cutover
RETAINED_SQL=$BACKUP_DIR/retained-check.sql
RETAINED_BEFORE=$BACKUP_DIR/retained-before.tsv
ROLLBACK_RECORD=$BACKUP_DIR/rollback-record.sh
ROLLBACK_RECORD_SEAL=$BACKUP_DIR/rollback-record.sha256
ROLLBACK_GUARDS=$BACKUP_DIR/runtime-raiders-cutover-guards.sh
DB_OWNER="$(stat -c '%U' "$DB")"
DB_GROUP="$(stat -c '%G' "$DB")"
DB_MODE="$(stat -c '%a' "$DB")"
GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh
PRIOR_ENV_SHA256="$(sudo sha256sum "$CURRENT_ENV" | awk '{print $1}')"
sudo install -d -o root -g root -m 0700 "$BACKUP_DIR"

sudo -u rluser git --no-optional-locks -C "$REPO" rev-parse HEAD
sudo install -o root -g root -m 0600 "$CURRENT_ENV" "$PRIOR_ENV_BACKUP"
sudo sqlite3 "$DB" ".timeout 10000" ".backup '$DB_BACKUP'"
sudo chown root:root "$DB_BACKUP"
sudo chmod 0600 "$DB_BACKUP"
test "$(sudo sqlite3 -readonly "$DB_BACKUP" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;')" = ok
DB_BACKUP_SHA256="$(sudo sha256sum "$DB_BACKUP" | awk '{print $1}')"
[[ "$DB_BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$PRIOR_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]]
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
sudo install -o root -g root -m 0600 "$CUTOVER_GUARDS" "$ROLLBACK_GUARDS"
test "$(sudo stat -c '%U:%G:%a' "$ROLLBACK_GUARDS")" = root:root:600
sudo bash -n "$ROLLBACK_GUARDS"

write_rollback_field() {
  printf '%s=%q\n' "$1" "${!1}"
}
ROLLBACK_FIELDS=(
  ROLLBACK_RECORD_VERSION PRIOR_SHA RELEASE_SHA CUTOVER_ID
  REPO DB CURRENT_ENV SERVICE UPDATER_TIMER UPDATER_SERVICE
  BACKUP_DIR DB_BACKUP DB_BACKUP_SHA256
  PRIOR_ENV_BACKUP PRIOR_ENV_SHA256 RETAINED_SQL RETAINED_BEFORE
  DB_OWNER DB_GROUP DB_MODE GAME_EXEC_PATH
  ROLLBACK_RECORD ROLLBACK_RECORD_SEAL ROLLBACK_GUARDS
)
for field in "${ROLLBACK_FIELDS[@]}"; do
  test -n "${!field}"
done
{
  for field in "${ROLLBACK_FIELDS[@]}"; do
    write_rollback_field "$field"
  done
} | sudo install -o root -g root -m 0600 /dev/stdin "$ROLLBACK_RECORD"

ROLLBACK_RECORD_SHA256="$(sudo sha256sum "$ROLLBACK_RECORD" | awk '{print $1}')"
[[ "$ROLLBACK_RECORD_SHA256" =~ ^[0-9a-f]{64}$ ]]
printf '%s\n' "$ROLLBACK_RECORD_SHA256" |
  sudo install -o root -g root -m 0600 /dev/stdin "$ROLLBACK_RECORD_SEAL"
test "$(sudo stat -c '%U:%G:%a' "$ROLLBACK_RECORD")" = root:root:600
test "$(sudo stat -c '%U:%G:%a' "$ROLLBACK_RECORD_SEAL")" = root:root:600
SEALED_RECORD_SHA256="$(sudo awk '
  NR == 1 && NF == 1 { value = $1; next }
  { exit 1 }
  END { if (NR != 1) exit 1; print value }
' "$ROLLBACK_RECORD_SEAL")"
test "$SEALED_RECORD_SHA256" = "$ROLLBACK_RECORD_SHA256"
test "$(sudo sha256sum "$ROLLBACK_RECORD" | awk '{print $1}')" = \
  "$SEALED_RECORD_SHA256"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
```

Copy the literal `ROLLBACK_RECORD`, `ROLLBACK_RECORD_SEAL`, and
`ROLLBACK_RECORD_SHA256` values to the restricted operator record. During
rollback, enter that independently copied checksum as
`EXPECTED_ROLLBACK_RECORD_SHA256`. The detached
seal avoids the impossible circular requirement for a file to contain its own
hash. Do not stop the service unless the record and seal are complete,
root-owned mode `0600`, and the seal verifies. If any query, backup, record, or
seal check fails, abort before the planned service stop.

### 4.3 Stop at the mixed-state boundary

```sh
sudo systemctl stop "$SERVICE"
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
```

From this point until the new checkout, dependencies, reviewed environment, and
migration-on-start are all complete, the service stays stopped. Never expose old
code with the new environment or new code with the old environment.

### 4.4 Install the exact release and environment while stopped

```sh
rr_assert_owned_tree "$REPO"
sudo -u rluser -H git -C "$REPO" merge --ff-only "$RELEASE_SHA"
rr_assert_checkout "$REPO" "$RELEASE_SHA" "$RELEASE_SHA"

if ! sudo -u rluser git --no-optional-locks -C "$REPO" diff --quiet \
  "$PRIOR_SHA" "$RELEASE_SHA" -- package.json package-lock.json; then
  sudo -u rluser -H sh -c 'cd "$1" && npm ci --include=dev' sh "$REPO"
fi

sudo install -o root -g root -m 0600 "$CANDIDATE_ENV" "$CURRENT_ENV"
test "$(sudo stat -c '%U:%G:%a' "$CURRENT_ENV")" = root:root:600
test "$(sudo sha256sum "$CURRENT_ENV" | awk '{print $1}')" = \
  "$CANDIDATE_ENV_SHA256"
rr_assert_owned_tree "$REPO"
sudo -u rluser test -x "$REPO/node_modules/.bin/tsx"
test "$(stat -c '%U' "$REPO/node_modules")" = rluser
rr_assert_owned_tree "$REPO/node_modules"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive
```

The installed SHA-256 must equal the reviewed candidate SHA-256. Confirm exactly
one original and one v2 cutover timestamp, `SCORING_MODE=runtime-raiders`, exact
`codex_desktop,codex_cli`, both exact policy paths and JSON document versions
`1` and `2`, existing DB/sprite paths, strong secrets, and no
`OTEL_ENDPOINT_HOST`. Do not print the environment.

### 4.5 Start once and wait for migration/health

`openDb` applies the additive migration at service start; there is no separate
production migration command.

Reassert the entire start boundary immediately before the one permitted start.
Do not start if any checkout, dependency, environment, database, ownership,
unit, or updater fact changed:

```sh
rr_assert_checkout "$REPO" "$RELEASE_SHA" "$RELEASE_SHA"
rr_assert_owned_tree "$REPO"
sudo -u rluser test -x "$REPO/node_modules/.bin/tsx"
test "$(sudo stat -c '%U:%G:%a' "$CURRENT_ENV")" = root:root:600
test "$(sudo sha256sum "$CURRENT_ENV" | awk '{print $1}')" = \
  "$CANDIDATE_ENV_SHA256"
test "$(stat -c '%U:%G:%a' "$DB")" = "$DB_OWNER:$DB_GROUP:$DB_MODE"
test "$(sudo -u rluser sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;')" = ok
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive

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

After controlled canaries, every new `runs.policy_version` must match its Run
start: the persisted key is `raid-power-v1` before
`RAID_POWER_V2_CUTOVER_AT` and `raid-power-v2` from that cutoff onward (not the
JSON document's numeric versions `1` and `2`). All Run starts must be at or
after `CUTOVER_AT`, and `players.total_tokens` must remain at its retained
baseline. Do not rewrite existing lifetime state.

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

### 5.3 Publish the exact signed quartet

Only after sections 5.1 and 5.2 pass may the release owner separately authorize
publication of the exact validated `install.sh`, ZIP, adjacent checksum, and
static update manifest. Record `INSTALLER_SHA256`, `ZIP_SHA256`,
`CHECKSUM_SHA256`, `UPDATE_MANIFEST_SHA256`, `RELEASE_SEQUENCE`,
`COMPANION_VERSION`, and `UPDATE_PROTOCOL_VERSION` separately in the restricted
operator record. The tracked
`companion/RELEASE` binds the clean SHA to its version and monotonic sequence.
Copy exactly those four reviewed files into one root-controlled, nonsymlink
`SOURCE_DIR` beneath `/var/lib/runtime-raiders` on the Pi. That directory
contains `install.sh`, `runtime-raiders-agent.zip`,
`runtime-raiders-agent.zip.sha256`, and `runtime-raiders-agent.update.json`.
A build output directory by itself is not a publication path, and copying does
not authorize selection or serving.

From the exact deployed checkout, publish only after the separate approval:

```sh
(
  set -eu
  cd "$REPO"
  sudo scripts/pi/runtime-raiders-artifacts.sh publish \
  --source "$SOURCE_DIR" \
  --release-sha "$RELEASE_SHA" \
  --release-sequence "$RELEASE_SEQUENCE" \
  --companion-version "$COMPANION_VERSION" \
  --update-protocol-version "$UPDATE_PROTOCOL_VERSION" \
  --installer-sha256 "$INSTALLER_SHA256" \
  --zip-sha256 "$ZIP_SHA256" \
  --checksum-sha256 "$CHECKSUM_SHA256" \
  --update-manifest-sha256 "$UPDATE_MANIFEST_SHA256"
  sudo scripts/pi/runtime-raiders-artifacts.sh status
)
```

Download each HTTPS response independently into an owner-only temporary
directory. Compare all four bytestrings with their separately recorded
digests, require `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` on every response, and confirm `/health`
remains `200`:

```sh
(
  set -eu
  umask 077
  VERIFY_DIR="$(mktemp -d)"
  trap 'rm -rf "$VERIFY_DIR"' EXIT
chmod 0700 "$VERIFY_DIR"
header_has_exact_value() {
  awk -v wanted_name="$2" -v wanted_value="$3" '
    {
      sub(/\r$/, "")
      if ($0 ~ /^HTTP\/1\.[0-9][[:space:]]+[0-9][0-9][0-9]([[:space:]].*)?$/ ||
          $0 ~ /^HTTP\/2[[:space:]]+[0-9][0-9][0-9]([[:space:]].*)?$/) {
        have_status = 1
        in_headers = 1
        block_ended = 0
        occurrences = 0
        exact = 0
        malformed = 0
        next
      }
      if (!in_headers) next
      if ($0 == "") {
        in_headers = 0
        block_ended = 1
        next
      }
      separator = index($0, ":")
      if (separator == 0) {
        candidate = $0
        sub(/[[:space:]].*$/, "", candidate)
        if (tolower(candidate) == tolower(wanted_name)) malformed = 1
        next
      }
      raw_name = substr($0, 1, separator - 1)
      name = raw_name
      value = substr($0, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (tolower(name) == tolower(wanted_name)) {
        occurrences++
        if (raw_name != name) malformed = 1
        if (value == wanted_value) exact++
      }
    }
    END {
      exit(have_status && block_ended && !malformed &&
        occurrences == 1 && exact == 1 ? 0 : 1)
    }
  ' "$1"
}
download_exact_https() {
  max_bytes=$1
  output=$2
  headers=$3
  url=$4
  download_http_code="$(curl --silent --show-error --suppress-connect-headers --proto '=https' \
    --proto-redir '=https' --max-redirs 0 --connect-timeout 10 --max-time 120 \
    --max-filesize "$max_bytes" --dump-header "$headers" --output "$output" \
    --write-out '%{http_code}' "$url")" || return 1
  test "$download_http_code" = 200
}
download_exact_https 8388608 \
  "$VERIFY_DIR/install.sh" "$VERIFY_DIR/install.headers" \
  'https://raiders.redlattice.com/install.sh'
download_exact_https 134217728 \
  "$VERIFY_DIR/runtime-raiders-agent.zip" "$VERIFY_DIR/zip.headers" \
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
download_exact_https 4096 \
  "$VERIFY_DIR/runtime-raiders-agent.zip.sha256" "$VERIFY_DIR/checksum.headers" \
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'
download_exact_https 65536 \
  "$VERIFY_DIR/runtime-raiders-agent.update.json" "$VERIFY_DIR/manifest.headers" \
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json'
test "$(sha256sum "$VERIFY_DIR/install.sh" | awk '{print $1}')" = \
  "$INSTALLER_SHA256"
test "$(sha256sum "$VERIFY_DIR/runtime-raiders-agent.zip" | awk '{print $1}')" = \
  "$ZIP_SHA256"
test "$(sha256sum "$VERIFY_DIR/runtime-raiders-agent.zip.sha256" | awk '{print $1}')" = \
  "$CHECKSUM_SHA256"
test "$(sha256sum "$VERIFY_DIR/runtime-raiders-agent.update.json" | awk '{print $1}')" = \
  "$UPDATE_MANIFEST_SHA256"
for headers in "$VERIFY_DIR"/*.headers; do
  header_has_exact_value "$headers" 'Cache-Control' 'no-store'
  header_has_exact_value "$headers" 'X-Content-Type-Options' 'nosniff'
done
download_exact_https 4096 /dev/null /dev/null \
  'https://raiders.redlattice.com/health'
)
```

Any publication, status, digest, header, or health failure blocks installation.
The publisher automatically restores the prior selector or removes a new first
selector when its verification fails; do not run a separate withdrawal. If
secondary acceptance fails, inspect status first. Withdraw only if status still
selects the exact approved `$RELEASE_SHA`; never withdraw an unknown selection
or one changed out of band. Only that exact-selection case permits:

```sh
(
  set -eu
  sudo scripts/pi/runtime-raiders-artifacts.sh withdraw \
  --release-sha "$RELEASE_SHA"
)
```

After an approved-SHA withdrawal or automatic first-selector removal,
`sudo scripts/pi/runtime-raiders-artifacts.sh status` must report `unpublished`.
Verify all four artifact URLs return `404` and both internal health URLs remain
`200`. If the publisher restored a prior selector, instead require status and
public verification to match that exact prior release:

```sh
(
  set -eu
  sudo scripts/pi/runtime-raiders-artifacts.sh status
exact_https_status() {
  curl --silent --show-error --proto '=https' --proto-redir '=https' \
    --max-redirs 0 --connect-timeout 10 --max-time 30 --max-filesize 4096 \
    --output /dev/null --write-out '%{http_code}' "$1"
}
for url in \
  https://raiders.redlattice.com/install.sh \
  https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip \
  https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256 \
  https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json; do
  test "$(exact_https_status "$url")" = 404
done
for url in \
  https://raiders.redlattice.com/health \
  https://clauderpg.redlattice.com/health; do
  test "$(exact_https_status "$url")" = 200
done
)
```

Publication and withdrawal do not reload Caddy or restart Node. The immutable
release directory remains for inspection; deleting it is not part of
withdrawal.

Publication acceptance completes only when the active full release SHA, all
four expected and independently downloaded digests, four response status and
header results, health status, and UTC timestamp are recorded without file
contents, source paths, tokens, enrollment codes, or environment contents.
Publication does not authorize installation.

### 5.4 Install one verified-off canary

Only after publication acceptance and a separate installation-specific
approval may the authorized Mac owner obtain a fresh one-time enrollment code.
Download the rendered installer locally into an owner-only temporary file,
verify its SHA-256 before execution, and run that verified local file. Do not
pipe a mutable remote response directly into a shell for this first canary:

```sh
(
  set -eu
  umask 077
  CANARY_INSTALLER="$(mktemp)"
CANARY_CODE_FILE="$(mktemp)"
cleanup_canary_files() { rm -f "$CANARY_INSTALLER" "$CANARY_CODE_FILE"; }
trap cleanup_canary_files EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0600 "$CANARY_INSTALLER"
chmod 0600 "$CANARY_CODE_FILE"
CANARY_STATUS="$(curl --fail --silent --show-error --proto '=https' \
  --proto-redir '=https' --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --max-filesize 8388608 --output "$CANARY_INSTALLER" \
  --write-out '%{http_code}' 'https://raiders.redlattice.com/install.sh')"
test "$CANARY_STATUS" = 200
test "$(shasum -a 256 "$CANARY_INSTALLER" | awk '{print $1}')" = \
  "$INSTALLER_SHA256"
printf 'Enter only the one-time code, save, and close the owner-only file.\n' >&2
/usr/bin/vi "$CANARY_CODE_FILE"
sh "$CANARY_INSTALLER" --code-file "$CANARY_CODE_FILE"
)
```

The transactional installer must finish with the real daemon live and all
three off-state facts present: `daemonRunning=true`, `enabled=false`, and
`persistedState=disabled`. Run `raiders status` and `raiders doctor`; do not run
`raiders on`. Confirm there are no Run uploads or server progression mutations.
Any ambiguous state, unexpected destination, signature/checksum mismatch,
daemon failure, or upload is a rollback trigger.

Complete the deployed-server, publication, and installed-off rows in
`docs/runtime-raiders/canary-checklist.md`. Installing off does not authorize
canary activation. The continuation is the separately approved two-sequence
record in `docs/runtime-raiders/companion-update-canary.md`: while still off,
build/review/sign a new clean-SHA sequence 3 and separately publish it,
then after the 24-hour startup-check due boundary restart its fixed launchd job,
observe one sequence-3 availability notification and run only `raiders update`
on the already-installed sequence-2 companion. Discovery is
an anonymous static GET only to the trusted game server's fixed
`runtime-raiders-agent.update.json` URL and may occur while collection is off;
it sends no provider telemetry. The manifest and ZIP are never executed or
piped. No manual-update proof authorizes `raiders on`.

## 6. Canary activation, office activation, and acceptance

The required post-cutover lifecycle is Caddy preparation approval →
sequence-2 publication → installed-off sequence-2 canary → sequence-3 build,
review, and signing → sequence-3 publication → notification/status proof →
manual `raiders update` → bounded `raiders on` Codex Desktop and Codex CLI
proof → `raiders off` proof → separate office activation → routine onboarding.
No arrow implies the next authority.

Only after the sequence-3 manual update proof remains disabled may the
activation owner separately authorize bounded canary enablement.

1. Reconfirm the approved canary reports the exact live-disabled state, then run
   `raiders on` only after explicit canary-activation approval.
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
6. Run `raiders off`, then prove disabled `raiders status` and `raiders doctor`.
   If every canary and off-proof passes, request separate office activation;
   that approval—not this canary—governs later routine onboarding.

Use content-free database aggregates to check the server-side canary boundary:

```sh
test "$(sudo sqlite3 -readonly "$DB" \
  "PRAGMA query_only=ON; SELECT count(*) FROM runs
   WHERE started_at_ms < $CUTOVER_AT
      OR policy_version <> 'raid-power-v1';")" = 0
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

This exact policy-key query is also executed by
`tests/runtime-raiders-e2e.test.ts` against a Run accepted through the real
enrollment and event routes; a prose-only check is not acceptance evidence. The
grouped output must contain only `codex_cli` and `codex_desktop`, with the
expected canary counts. The legacy lifetime token total must remain unchanged.

Any mismatch triggers section 7 immediately. Do not broaden
`RUN_ENABLED_SURFACES`, change policy, or enable Claude/Omp to work around it.

After canary and office acceptance, keep the updater held and close the
fail-closed cutover shell only after recording the accepted state:

```sh
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
test "$(systemctl is-active "$SERVICE")" = active
trap - ERR HUP INT TERM
```

Record the final SSE release SHA, persisted policy keys `raid-power-v1` and
`raid-power-v2`, JSON policy document versions `1` and `2`, exact `CUTOVER_AT`
and `RAID_POWER_V2_CUTOVER_AT`, test results, UI/kiosk/network results, canary
counts, user acceptance, and UTC time.
The temporary old FQDN remains compatible. Retiring it or renaming the repo,
database, env, service, or updater identifiers is a separate migration.

The updater state is explicit for every terminal outcome:

| Outcome | Game service | Updater timer | Updater oneshot |
| --- | --- | --- | --- |
| Accepted | Active only after all gates pass | Disabled and inactive | Inactive |
| Aborted before state-changing cutover | Prior operation; stop if the fail-closed cutover shell was entered | Disabled and inactive | Inactive |
| Rolled back | Prior SHA active only after rollback gates pass | Disabled and inactive | Inactive |

Do not enable the current updater after acceptance: it follows moving
`origin/main` and cannot enforce release authorization. A future separately
reviewed, recorded ongoing-auto-deploy policy may enable automation only if the
updater consumes an explicitly approved pinned SHA and rechecks that same SHA,
unit contract, pause gate, ownership, environment, and database integrity before
each checkout/start. Authorization of this cutover SHA does not authorize a
rejected or future SHA.

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
backup and prior SHA. First turn collection off on every enabled canary and
office Mac and verify `raiders status` reports off. Then open a clean root Bash
shell with `sudo -i`. Set only the two literal paths and expected checksum
copied to the restricted operator record before cutover; do not restore,
derive, or type any other rollback variable. Authenticate and validate the
immutable record before any rollback mutation:

```sh
set -Eeuo pipefail
ROLLBACK_RECORD=/var/backups/runtime-raiders/REPLACE_WITH_RECORDED_ID/rollback-record.sh
ROLLBACK_RECORD_SEAL=/var/backups/runtime-raiders/REPLACE_WITH_RECORDED_ID/rollback-record.sha256
EXPECTED_ROLLBACK_RECORD_SHA256=REPLACE_WITH_INDEPENDENTLY_RECORDED_64_LOWERCASE_HEX

case "$ROLLBACK_RECORD" in
  /var/backups/runtime-raiders/*/rollback-record.sh) ;;
  *) false ;;
esac
test "$ROLLBACK_RECORD_SEAL" = "${ROLLBACK_RECORD%/*}/rollback-record.sha256"
test -f "$ROLLBACK_RECORD"
test ! -L "$ROLLBACK_RECORD"
test -f "$ROLLBACK_RECORD_SEAL"
test ! -L "$ROLLBACK_RECORD_SEAL"
test "$(stat -c '%U:%G:%a' "$ROLLBACK_RECORD")" = root:root:600
test "$(stat -c '%U:%G:%a' "$ROLLBACK_RECORD_SEAL")" = root:root:600

BOOTSTRAP_ROLLBACK_GUARDS="${ROLLBACK_RECORD%/*}/runtime-raiders-cutover-guards.sh"
test -f "$BOOTSTRAP_ROLLBACK_GUARDS"
test ! -L "$BOOTSTRAP_ROLLBACK_GUARDS"
test "$(stat -c '%U:%G:%a' "$BOOTSTRAP_ROLLBACK_GUARDS")" = root:root:600
bash -n "$BOOTSTRAP_ROLLBACK_GUARDS"
# shellcheck source=/dev/null
source "$BOOTSTRAP_ROLLBACK_GUARDS"
rr_authenticate_rollback_record \
  "$ROLLBACK_RECORD" "$ROLLBACK_RECORD_SEAL" \
  "$EXPECTED_ROLLBACK_RECORD_SHA256"

BOOTSTRAP_ROLLBACK_RECORD=$ROLLBACK_RECORD
BOOTSTRAP_ROLLBACK_RECORD_SEAL=$ROLLBACK_RECORD_SEAL
BOOTSTRAP_EXPECTED_ROLLBACK_RECORD_SHA256=$EXPECTED_ROLLBACK_RECORD_SHA256
# shellcheck source=/dev/null
source "$ROLLBACK_RECORD"

REQUIRED_ROLLBACK_FIELDS=(
  ROLLBACK_RECORD_VERSION PRIOR_SHA RELEASE_SHA CUTOVER_ID
  REPO DB CURRENT_ENV SERVICE UPDATER_TIMER UPDATER_SERVICE
  BACKUP_DIR DB_BACKUP DB_BACKUP_SHA256
  PRIOR_ENV_BACKUP PRIOR_ENV_SHA256 RETAINED_SQL RETAINED_BEFORE
  DB_OWNER DB_GROUP DB_MODE GAME_EXEC_PATH
  ROLLBACK_RECORD ROLLBACK_RECORD_SEAL ROLLBACK_GUARDS
)
for field in "${REQUIRED_ROLLBACK_FIELDS[@]}"; do
  declare -p "$field" >/dev/null
  test -n "${!field}"
done

test "$ROLLBACK_RECORD_VERSION" = 2
test "$REPO" = /home/rluser/ClaudeRPG
test "$GAME_EXEC_PATH" = "$REPO/scripts/pi/run-server.sh"
test "$DB" = "$REPO/data/claude-rpg.db"
test "$CURRENT_ENV" = /etc/claude-rpg.env
test "$SERVICE" = claude-rpg.service
test "$UPDATER_TIMER" = claude-rpg-autoupdate.timer
test "$UPDATER_SERVICE" = claude-rpg-autoupdate.service
[[ "$PRIOR_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$PRIOR_SHA" != "$RELEASE_SHA"
[[ "$CUTOVER_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
test "$BACKUP_DIR" = "/var/backups/runtime-raiders/$CUTOVER_ID"
test "$DB_BACKUP" = "$BACKUP_DIR/claude-rpg.pre-cutover.db"
test "$PRIOR_ENV_BACKUP" = "$BACKUP_DIR/claude-rpg.env.pre-cutover"
test "$RETAINED_SQL" = "$BACKUP_DIR/retained-check.sql"
test "$RETAINED_BEFORE" = "$BACKUP_DIR/retained-before.tsv"
test "$ROLLBACK_RECORD" = "$BOOTSTRAP_ROLLBACK_RECORD"
test "$ROLLBACK_RECORD_SEAL" = "$BOOTSTRAP_ROLLBACK_RECORD_SEAL"
test "$ROLLBACK_GUARDS" = "$BOOTSTRAP_ROLLBACK_GUARDS"
test "$EXPECTED_ROLLBACK_RECORD_SHA256" = \
  "$BOOTSTRAP_EXPECTED_ROLLBACK_RECORD_SHA256"
[[ "$DB_BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$PRIOR_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$DB_OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$DB_GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$DB_MODE" =~ ^[0-7]{3,4}$ ]]
rr_authenticate_rollback_record \
  "$ROLLBACK_RECORD" "$ROLLBACK_RECORD_SEAL" \
  "$EXPECTED_ROLLBACK_RECORD_SHA256"

rollback_fail_closed() {
  local rc="${1:-1}"
  local cleanup_failed=0
  local service_state=''
  test "$rc" -ne 0 || rc=1
  trap - ERR HUP INT TERM
  set +e
  sudo systemctl disable --now "$UPDATER_TIMER" >/dev/null 2>&1 || cleanup_failed=1
  sudo systemctl stop "$UPDATER_SERVICE" >/dev/null 2>&1 || cleanup_failed=1
  sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || cleanup_failed=1
  rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE" || cleanup_failed=1
  rr_observe_systemctl service_state is-active "$SERVICE" || cleanup_failed=1
  test "$service_state" = inactive || cleanup_failed=1
  if test "$cleanup_failed" = 0; then
    echo "ROLLBACK FAIL-CLOSED: game stopped; updater held" >&2
  else
    echo "ROLLBACK FAIL-CLOSED: safe state could not be verified" >&2
  fi
  exit "$rc"
}
trap 'rollback_fail_closed $?' ERR
trap 'rollback_fail_closed 130' HUP INT TERM

rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
sudo systemctl stop "$SERVICE"
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive
```

Any missing, empty, altered, extra-line-seal, wrong-owner, wrong-mode,
independently recorded checksum mismatch, or inconsistent record field aborts
before rollback changes state. A self-consistent record and seal from another
cutover cannot satisfy the independently entered expected checksum. Never
source an unauthenticated record and never substitute a current filesystem
observation for a recorded rollback literal.

Verify the recorded logical backup **before moving the failed database**. The
checksum comparison is exact, not a fresh checksum printed for a human to
compare:

```sh
OBSERVED_DB_BACKUP_SHA256="$(sudo sha256sum "$DB_BACKUP" | awk '{print $1}')"
test "$OBSERVED_DB_BACKUP_SHA256" = "$DB_BACKUP_SHA256"
test "$(sudo sqlite3 -readonly "$DB_BACKUP" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;')" = ok
```

Create a unique incident directory under a protected parent. Record whether
each sidecar existed, require every destination to be absent, use no-clobber
moves, and prove that each source was preserved or was originally absent:

```sh
INCIDENT_PARENT="$BACKUP_DIR/incidents"
sudo install -d -o root -g root -m 0700 "$INCIDENT_PARENT"
FAILED_DIR=$(sudo mktemp -d "$INCIDENT_PARENT/failed-post-cutover.XXXXXX")
test "$(sudo stat -c '%U:%G:%a' "$FAILED_DIR")" = root:root:700

HAD_WAL=0
HAD_SHM=0
sudo test ! -e "$FAILED_DIR/claude-rpg.failed.db"
sudo test ! -e "$FAILED_DIR/claude-rpg.failed.db-wal"
sudo test ! -e "$FAILED_DIR/claude-rpg.failed.db-shm"
sudo test -f "$DB"
if sudo test -e "$DB-wal"; then HAD_WAL=1; fi
if sudo test -e "$DB-shm"; then HAD_SHM=1; fi

sudo mv --no-clobber "$DB" "$FAILED_DIR/claude-rpg.failed.db"
if test "$HAD_WAL" = 1; then
  sudo mv --no-clobber "$DB-wal" "$FAILED_DIR/claude-rpg.failed.db-wal"
fi
if test "$HAD_SHM" = 1; then
  sudo mv --no-clobber "$DB-shm" "$FAILED_DIR/claude-rpg.failed.db-shm"
fi

sudo test ! -e "$DB"
sudo test ! -e "$DB-wal"
sudo test ! -e "$DB-shm"
sudo test -f "$FAILED_DIR/claude-rpg.failed.db"
if test "$HAD_WAL" = 1; then
  sudo test -f "$FAILED_DIR/claude-rpg.failed.db-wal"
else
  sudo test ! -e "$FAILED_DIR/claude-rpg.failed.db-wal"
fi
if test "$HAD_SHM" = 1; then
  sudo test -f "$FAILED_DIR/claude-rpg.failed.db-shm"
else
  sudo test ! -e "$FAILED_DIR/claude-rpg.failed.db-shm"
fi
```

Restore only after proving the production main file and both sidecars are
absent. Reapply and verify exact owner/group/mode, then verify integrity as the
service user:

```sh
sudo test ! -e "$DB"
sudo test ! -e "$DB-wal"
sudo test ! -e "$DB-shm"
sudo sqlite3 "$DB" ".restore '$DB_BACKUP'"
sudo chown "$DB_OWNER:$DB_GROUP" "$DB"
sudo chmod "$DB_MODE" "$DB"
test "$(stat -c '%U:%G:%a' "$DB")" = "$DB_OWNER:$DB_GROUP:$DB_MODE"
sudo test ! -e "$DB-wal"
sudo test ! -e "$DB-shm"
test "$(sudo -u rluser sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;')" = ok
```

Switch the clean checkout and dependencies as `rluser`; both package manifests
trigger a deterministic development-dependency install:

```sh
rr_assert_checkout "$REPO" "$RELEASE_SHA" "$RELEASE_SHA"
rr_assert_owned_tree "$REPO"
printf 'rollback target: %s\n' "$PRIOR_SHA"
sudo -u rluser -H git -C "$REPO" reset --hard "$PRIOR_SHA"
rr_assert_checkout "$REPO" "$PRIOR_SHA" "$RELEASE_SHA"
if ! sudo -u rluser git --no-optional-locks -C "$REPO" diff --quiet \
  "$PRIOR_SHA" "$RELEASE_SHA" -- package.json package-lock.json; then
  sudo -u rluser -H sh -c 'cd "$1" && npm ci --include=dev' sh "$REPO"
fi
rr_assert_owned_tree "$REPO"
sudo -u rluser test -x "$REPO/node_modules/.bin/tsx"
```

Restore the prior environment, then reassert every boundary before the one
permitted rollback start:

```sh
test "$(sudo sha256sum "$PRIOR_ENV_BACKUP" | awk '{print $1}')" = \
  "$PRIOR_ENV_SHA256"
test "$(sudo stat -c '%U:%G:%a' "$PRIOR_ENV_BACKUP")" = root:root:600
sudo install -o root -g root -m 0600 "$PRIOR_ENV_BACKUP" "$CURRENT_ENV"
test "$(sudo stat -c '%U:%G:%a' "$CURRENT_ENV")" = root:root:600
test "$(sudo sha256sum "$CURRENT_ENV" | awk '{print $1}')" = \
  "$PRIOR_ENV_SHA256"
rr_assert_checkout "$REPO" "$PRIOR_SHA" "$RELEASE_SHA"
rr_assert_owned_tree "$REPO"
sudo -u rluser test -x "$REPO/node_modules/.bin/tsx"
test "$(stat -c '%U:%G:%a' "$DB")" = "$DB_OWNER:$DB_GROUP:$DB_MODE"
test "$(sudo -u rluser sqlite3 -readonly "$DB" \
  'PRAGMA query_only=ON; PRAGMA integrity_check;')" = ok
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive

sudo systemctl start "$SERVICE"
curl -fsS --retry 30 --retry-delay 2 --retry-connrefused \
  http://localhost:8080/health
test "$(systemctl is-active "$SERVICE")" = active
```

Verify retained pre-cutover aggregates, old internal HTTPS, physical localhost
kiosk and Leaderboard, and a `/tv/stream` version equal to the recorded short
`PRIOR_SHA`. Keep all companions off. Recheck `rr_assert_updater_held`, record the unique
failed database directory and rollback result, then `trap - ERR HUP INT TERM`.
Investigate only with copies of the failed DB, logs, and synthetic/offline
fixtures. Any retry requires a new record, backup, preflight, and authorization.

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
- [ ] Exact repository publication and fail-closed Caddy preparation had
      separate approvals; the prior Caddy config backup/checksum was recorded.
- [ ] `/var/lib/runtime-raiders/current` was absent and all four artifact URLs
      returned `404` before final preflight.
- [ ] Fresh preflight ended READY with a final paused read.
- [ ] Logical `.backup` integrity and retained-state baseline were verified.
- [ ] Service stayed stopped across checkout/dependencies/env installation.
- [ ] Migration, integrity, retained state, scoring exclusivity, policy,
      routes, both FQDNs, mDNS, physical kiosk, Leaderboard, and SSE SHA passed.
- [ ] Old OTel is removed manually; no content or secrets were reported.
- [ ] Signed publication was separately approved; manager `status`, all four
      independently downloaded digests, `no-store`, `nosniff`, and health passed.
- [ ] The first canary used a locally downloaded, hash-verified installer and
      was daemon-live and persistently off before activation approval.
- [ ] Only Codex Desktop and Codex CLI canaries passed; Claude Code and Omp
      stayed disabled and rejected.
- [ ] Office activation occurred only after separate approval and canary
      acceptance.
- [ ] Updater timer is disabled/inactive and oneshot inactive for the recorded
      accepted, aborted, or rolled-back outcome.
- [ ] Final status is accepted, aborted, or rolled back, with loss semantics
      acknowledged.
