# Runtime Raiders Publication Recovery Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque sequence-1 publication check with complete,
diagnostic, bounded, fail-closed verification and produce—but do not publish—a
reviewed signed sequence-2 companion quartet.

**Architecture:** Keep `runtime-raiders-artifacts.sh` as the single authority for
local validation, immutable staging, atomic selection, public verification, and
selector rollback. Expand its post-selection verifier into focused shell helpers
for exact artifact checks, header parsing, health checks, and bounded retries;
exercise them through the existing injected-command Vitest fixture.

**Tech Stack:** Bash 5 on Raspberry Pi OS, curl, Node.js 20, TypeScript, Vitest,
Swift 6, macOS codesign/notarytool/stapler, Caddy

## Global Constraints

- Sequence 1 is withdrawn and consumed; never reselect, modify, delete, or
  repackage it.
- The recovery release is a new clean Git SHA with
  `companion_version=0.2.0`, `release_sequence=2`, and
  `update_protocol_version=1`.
- Verify exactly `/install.sh`, the ZIP, checksum, and update manifest through
  `https://raiders.redlattice.com`; do not add a preview route or Caddy change.
- Artifact bounds are 1 MiB for the installer, 128 MiB for the ZIP, 4 KiB for
  the checksum, and 64 KiB for the update manifest.
- Every artifact must return HTTP `200`, match its approved SHA-256, contain
  `Cache-Control: no-store`, and contain `X-Content-Type-Options: nosniff`.
- The update manifest must also pass the existing canonical manifest validator.
- Verify `https://raiders.redlattice.com/health` and
  `http://127.0.0.1:8080/health` without recording their bodies.
- Each public GET has at most five attempts, a three-second connect timeout, a
  15-second total timeout, and a one-second delay between availability failures.
- The local Node health check has one five-second attempt.
- Retry only transport or non-`200` availability failures; digest, size, header,
  and manifest failures fail immediately.
- Keep stable publication status fields on stdout. Send content-free verification
  checkpoints to stderr; never emit bodies, header blocks, paths, provider data,
  prompts, responses, native IDs, tokens, credentials, or environment values.
- Preserve the publication lock, immutable releases, selector identity checks,
  prior-selector rollback, race refusal, signal behavior, and temp cleanup.
- A failed sequence-2 publication consumes sequence 2 and requires a new clean
  SHA and sequence 3; it never permits sequence-2 reselection.
- Do not change Caddy, DNS, Node, database data, scoring, provider adapters,
  companion collection behavior, or office activation state.
- Do not push, fetch on the Pi, check out production, publish, install, update,
  or enable a companion without a later separately named authorization.

---

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `scripts/pi/runtime-raiders-artifacts.sh` | URLs and limits, diagnostic checkpoints, header parsing, quartet verification, retry, health verification, and rollback transaction |
| `tests/runtime-raiders-artifacts.test.ts` | Injected curl/sleep behavior, quartet and health assertions, retry bounds, diagnostics privacy, and rollback preservation |
| `docs/runtime-raiders/companion-operations.md` | Authoritative sequence-2 recovery and sequence-3 update-proof procedure |
| `tests/runtime-raiders-publication-docs.test.ts` | Executable assertions for the updated operations procedure |
| `companion/RELEASE` | Signed recovery identity: version `0.2.0`, sequence `2`, protocol `1` |
| `tests/companion-installer.test.ts` | Builder assertion that sequence 2 is embedded in signed metadata |
| `dist/sequence-2-${RR_RELEASE_SHA}/` | Untracked signed/notarized quartet produced after review |
| `dist/runtime-raiders-sequence-2-${RR_RELEASE_SHORT}.txt` | Owner-only release identity and evidence record |

The existing publisher and test fixture stay in place; this recovery introduces
no new service, Caddy route, public host, or protocol.

---

### Task 1: Verify the complete quartet, headers, and health paths

**Files:**
- Modify: `tests/runtime-raiders-artifacts.test.ts:25-325, 489-1122`
- Modify: `scripts/pi/runtime-raiders-artifacts.sh:5-34, 406-434, 710-719`

**Interfaces:**
- Produces: `verification_checkpoint LABEL ATTEMPT MAX RESULT CATEGORY [DETAIL]`.
- Produces: `header_has_exact_value HEADER_FILE NAME VALUE -> status`.
- Produces: `verify_public_artifact LABEL URL MAX_BYTES OUTPUT EXPECTED_SHA256 MAX_ATTEMPTS -> status`.
- Produces: `verify_health LABEL URL PROTOCOL MAX_TIME MAX_ATTEMPTS -> status`.
- Preserves: `verify_selected_public_release -> status`, stable stdout, and the
  existing cleanup rollback trap.
- Consumed by: Task 2 retry behavior and all later gates.

- [ ] **Step 1: Write a failing full-contract test**

Add these exact test constants:

```ts
const publicTargets = [
  ['installer', 'https://raiders.redlattice.com/install.sh', '1048576'],
  ['zip', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip', '134217728'],
  ['checksum', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256', '4096'],
  ['manifest', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json', '65536'],
] as const;
const publicHealthURL = 'https://raiders.redlattice.com/health';
const localHealthURL = 'http://127.0.0.1:8080/health';
```

Replace the current two-curl assertion with a test that requires six requests,
the four exact URL/bound pairs, both health URLs, and these four success lines:

```ts
for (const [label, url, maxBytes] of publicTargets) {
  expect(curlCommands.some((line) =>
    line.includes(`--max-filesize ${maxBytes}`) && line.endsWith(` ${url}`),
  ), label).toBe(true);
  for (const category of ['status', 'size', 'digest', 'cache-control', 'nosniff', 'complete']) {
    expect(published.stderr).toContain(
      `verify label=${label} attempt=1/1 result=ok category=${category}`,
    );
  }
}
expect(published.stderr).not.toContain(f.root);
```

Change the canonical publication test to keep its exact eight stdout fields but
accept content-free stderr checkpoints instead of empty stderr.

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
npm test -- tests/runtime-raiders-artifacts.test.ts
```

Expected: FAIL because the old verifier requests only ZIP and manifest and emits
no checkpoints.

- [ ] **Step 3: Extend the fake curl to emulate exact production responses**

Accept only the planned options:

```sh
--connect-timeout) test "$2" = 3; shift 2 ;;
--max-time) case "$2" in 5|15) ;; *) exit 64 ;; esac; shift 2 ;;
--dump-header) test -z "$headers"; headers=$2; shift 2 ;;
--write-out) test "$2" = '%{http_code}'; shift 2 ;;
--max-filesize) max_size=$2; shift 2 ;;
--proto) case "$2" in '=https'|'=http') protocol=$2 ;; *) exit 64 ;; esac; shift 2 ;;
--output) test -z "$output"; output=$2; shift 2 ;;
--fail|--silent|--show-error|--no-location) shift ;;
```

Map exact URL/bound pairs to labels and selected files:

```sh
case "$url:$max_size" in
  'https://raiders.redlattice.com/install.sh:1048576')
    label=installer; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/install.sh" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip:134217728')
    label=zip; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.zip" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256:4096')
    label=checksum; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.zip.sha256" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json:65536')
    label=manifest; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.update.json" ;;
  'https://raiders.redlattice.com/health:') label=public-health ;;
  'http://127.0.0.1:8080/health:') label=local-health ;;
  *) exit 64 ;;
esac
```

For artifacts, copy the selected file and write exactly `HTTP/2 200`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and a blank line to
the header file. For health, require `/dev/null` output and write no body. Print
exactly `200` for `%{http_code}`. Continue rejecting curl configuration,
redirects, extra transfers, and unexpected protocols.

- [ ] **Step 4: Add fixed constants and diagnostic helpers**

Replace the two URL constants with:

```bash
PUBLIC_ORIGIN=https://raiders.redlattice.com
PUBLIC_INSTALLER_URL=$PUBLIC_ORIGIN/install.sh
PUBLIC_ZIP_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.zip
PUBLIC_CHECKSUM_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.zip.sha256
PUBLIC_UPDATE_MANIFEST_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.update.json
PUBLIC_HEALTH_URL=$PUBLIC_ORIGIN/health
LOCAL_HEALTH_URL=http://127.0.0.1:8080/health
INSTALLER_MAX_BYTES=1048576
ZIP_MAX_BYTES=134217728
CHECKSUM_MAX_BYTES=4096
UPDATE_MANIFEST_MAX_BYTES=65536
```

Add:

```bash
verification_checkpoint() {
  printf 'runtime-raiders-artifacts: verify label=%s attempt=%s/%s result=%s category=%s%s\n' \
    "$1" "$2" "$3" "$4" "$5" "${6:+ detail=$6}" >&2
}

header_has_exact_value() {
  awk -v wanted_name="$2" -v wanted_value="$3" '
    {
      sub(/\r$/, "")
      separator = index($0, ":")
      if (separator == 0) next
      name = substr($0, 1, separator - 1)
      value = substr($0, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (tolower(name) == tolower(wanted_name) &&
          tolower(value) == tolower(wanted_value)) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$1"
}
```

- [ ] **Step 5: Implement one-attempt artifact and health helpers**

The artifact curl command must be exactly:

```bash
"$CURL" --disable --no-location --proto '=https' --fail --silent --show-error \
  --connect-timeout 3 --max-time 15 --max-filesize "$max_bytes" \
  --dump-header "$headers" --output "$output" --write-out '%{http_code}' "$url"
```

Require status `200`, a nonempty nonsymlink regular output within `max_bytes`,
the exact SHA-256, and both exact headers. Emit an `ok` checkpoint after each
successful `status`, `size`, `digest`, `cache-control`, and `nosniff` assertion,
then emit `complete`. Emit the failing category before returning nonzero. Use the
same curl restrictions for health, with HTTPS/15 seconds for public health and
loopback HTTP/5 seconds for local health, sending bodies to `/dev/null`.

- [ ] **Step 6: Replace the verifier with the fixed order**

After creating the existing root-only verification directory, call installer,
ZIP, checksum, manifest, canonical manifest validation, public health, and local
health in that order. Pass max attempts `1` in this task. Run canonical manifest
validation in a conditional subshell so failure emits `category=manifest` and
returns through the existing rollback trap. Do not change `select_release`,
`restore_previous_selector`, or `cleanup`.

- [ ] **Step 7: Add deterministic failure coverage**

Add table-driven fake controls for all four digest failures, oversized output,
missing `no-store`, missing `nosniff`, invalid canonical manifest, public health
failure, and local health failure. Each case must restore the prior selector or
remove a first selector, preserve the failed immutable release, clean temporary
paths, leave stdout empty, name only the fixed label/category on stderr, and
exclude the fixture root and supplied sensitive marker.

- [ ] **Step 8: Verify and commit the complete one-attempt contract**

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
npm test -- tests/runtime-raiders-artifacts.test.ts
git add scripts/pi/runtime-raiders-artifacts.sh tests/runtime-raiders-artifacts.test.ts
git commit -m "fix(raiders): verify full public release contract"
```

Expected: syntax and focused tests pass; success performs six fixed requests and
all deterministic failures restore the selector.

---

### Task 2: Add bounded availability retries and per-attempt evidence

**Files:**
- Modify: `tests/runtime-raiders-artifacts.test.ts:88-325, 812-910`
- Modify: `scripts/pi/runtime-raiders-artifacts.sh:5-18, Task-1 verification helpers`

**Interfaces:**
- Adds: `SLEEP`, injected as `RUNTIME_RAIDERS_SLEEP` in test mode.
- Changes: public max attempts from `1` to `5`; Task-1 helper signatures remain.
- Preserves: deterministic content failures stop after one HTTP `200` response.

- [ ] **Step 1: Add failing retry-bound tests**

Extend the fixture with a `curlState` directory and inject it as
`RUNTIME_RAIDERS_TEST_CURL_STATE_DIR`. Add:

```ts
it('succeeds on the third attempt after two transient request failures', () => {
  const f = publicationFixture();
  const published = runPublish(f, {
    RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'installer',
    RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '2',
    RUNTIME_RAIDERS_TEST_FAIL_MODE: 'transport',
  });
  expect(published.status, published.stderr).toBe(0);
  expect(published.stderr).toContain('label=installer attempt=1/5 result=retry category=request');
  expect(published.stderr).toContain('label=installer attempt=2/5 result=retry category=request');
  expect(published.stderr).toContain('label=installer attempt=3/5 result=ok category=complete');
  expect(readFileSync(f.commandLog, 'utf8').match(/sleep 1/g)).toHaveLength(2);
});

it('stops after five availability attempts and restores the prior selector', () => {
  const priorSha = 'a'.repeat(40);
  const f = publicationFixture();
  setPublicationIdentity(f, priorSha, 1);
  expect(runPublish(f).status).toBe(0);
  setPublicationIdentity(f, releaseSha, 2);
  const failed = runPublish(f, {
    RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'zip',
    RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '5',
    RUNTIME_RAIDERS_TEST_FAIL_MODE: 'status',
  });
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain('label=zip attempt=5/5 result=fail category=status');
  expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
});
```

Add digest and header tests that require exactly one curl for the failing label
and zero sleep calls after its HTTP `200`.

- [ ] **Step 2: Run the focused suite and verify single-attempt failure**

```bash
npm test -- tests/runtime-raiders-artifacts.test.ts
```

Expected: FAIL because Task 1 stops after one attempt and has no injected sleep.

- [ ] **Step 3: Add deterministic fake request state and sleep**

After URL-to-label mapping, key the counter by selected release and label so a
prior publication in the same fixture cannot consume the next publication's
failure budget:

```sh
selected_release=$(/bin/readlink "$RUNTIME_RAIDERS_ARTIFACT_ROOT/current")
selected_sha=${selected_release##*/}
count_file="$RUNTIME_RAIDERS_TEST_CURL_STATE_DIR/$selected_sha-$label"
count=0
test ! -f "$count_file" || count=$(/bin/cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
if test "${RUNTIME_RAIDERS_TEST_FAIL_LABEL:-}" = "$label" &&
    test "$count" -le "${RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS:-0}"; then
  case "${RUNTIME_RAIDERS_TEST_FAIL_MODE:-transport}" in
    transport) exit 28 ;;
    status) printf '503'; exit 22 ;;
    *) exit 64 ;;
  esac
fi
```

Add a fake `sleep` that accepts exactly `1`, logs `sleep 1`, and exits `0`.
Inject `RUNTIME_RAIDERS_SLEEP: join(environment.fakes, 'sleep')` in `run()`.

- [ ] **Step 4: Add exact production retry constants**

```bash
SLEEP=/usr/bin/sleep
PUBLIC_VERIFY_ATTEMPTS=5
PUBLIC_CONNECT_TIMEOUT=3
PUBLIC_TOTAL_TIMEOUT=15
PUBLIC_RETRY_DELAY=1
LOCAL_HEALTH_TOTAL_TIMEOUT=5
```

In test mode require `RUNTIME_RAIDERS_SLEEP` beside curl and Node. Do not accept
environment overrides outside test mode.

- [ ] **Step 5: Loop only request and non-200 failures**

Wrap each public curl in `attempt=1` through `PUBLIC_VERIFY_ATTEMPTS`. Before
each attempt, remove that label's prior output and header file. Categorize a
missing/`000` status as `request` and any other non-`200` status as `status`.
Emit `result=retry`, run `"$SLEEP" 1`, and increment unless the fifth attempt has
been reached; the fifth emits `result=fail` and returns nonzero.
Once HTTP `200` is received, run Task 1's size, digest, header, and manifest
assertions once and return their result without retrying. Public health uses the
same loop; local health receives exactly one attempt and never sleeps.

- [ ] **Step 6: Prove retry bounds, rollback, and privacy**

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
npm test -- tests/runtime-raiders-artifacts.test.ts
```

Expected: three installer requests/two sleeps for transient success; five ZIP
requests/four sleeps for exhaustion; one request/no sleep for deterministic
failures; rollback, immutable preservation, races, signals, and cleanup pass.

- [ ] **Step 7: Commit the retry unit**

```bash
git add scripts/pi/runtime-raiders-artifacts.sh tests/runtime-raiders-artifacts.test.ts
git commit -m "fix(raiders): bound publication retries and diagnostics"
```

---

### Task 3: Advance the authoritative procedure to sequence 2

**Files:**
- Modify: `tests/runtime-raiders-publication-docs.test.ts:79-112, 242-258`
- Modify: `tests/companion-installer.test.ts:1230-1241`
- Modify: `docs/runtime-raiders/companion-operations.md:7-86`
- Modify: `companion/RELEASE:1-4`

**Interfaces:**
- Produces: tracked identity `0.2.0 / sequence 2 / protocol 1`.
- Produces: operations wording for automatic rollback, independent acceptance,
  the installed-off sequence-2 canary, and sequence-3 manual update proof.
- Consumed by: Task 4 gates and Task 5 signed builder.

- [ ] **Step 1: Write failing procedure and embedded-identity assertions**

Require these statements in the operations test:

```ts
expect(operations).toContain('Sequence 1 is withdrawn and consumed');
expect(operations).toContain('release_sequence=2');
expect(operations).toContain('## Install the sequence-2 canary locally and persistently off');
expect(operations).toMatch(/publisher[\s\S]*all four[\s\S]*bounded retries/i);
expect(operations).toMatch(/verification failure[\s\S]*restores[\s\S]*selector/i);
expect(operations).toMatch(/sequence 2 becomes the initial installed-off canary/i);
expect(operations).toMatch(/manual `raiders update` proof[\s\S]*sequence 3/i);
```

Change the disposable builder's tracked
`RuntimeRaidersReleaseSequence` expectation from `'1'` to `'2'`. Keep malformed
fixture strings at sequence 1 where they test parsing rather than tracked state.

- [ ] **Step 2: Run focused tests and verify the old procedure fails**

```bash
npm test -- tests/runtime-raiders-publication-docs.test.ts tests/companion-installer.test.ts
```

Expected: FAIL because the guide and tracked file still identify sequence 1.

- [ ] **Step 3: Rewrite the operations guide around recovery state**

Keep the exact four-file publish command and arguments. State explicitly that:

1. Sequence 1 is withdrawn immutable evidence and its sequence is consumed.
2. Recovery is version `0.2.0`, sequence `2`, protocol `1`, and a clean new SHA.
3. The publisher checks four HTTPS objects, digests, headers, manifest, and both
   health paths with bounded retries and content-free stderr checkpoints.
4. Publisher failure restores the prior selector or removes a first selector.
5. Independent checking is secondary acceptance and cannot override failure.
6. If secondary acceptance fails and status still selects the approved SHA,
   withdraw only that SHA; never withdraw an unknown selection.
7. Sequence 2 is the locally downloaded, digest-verified, persistently-off
   initial canary.
8. The manual `raiders update` proof moves to reviewed/published sequence 3.

Preserve the no-pipe controlled canary, later routine one-line installer,
collection-off behavior, privacy limits, and separate activation approval.

- [ ] **Step 4: Advance only the monotonic sequence**

Set `companion/RELEASE` exactly to:

```text
version=1
companion_version=0.2.0
release_sequence=2
update_protocol_version=1
```

- [ ] **Step 5: Verify and commit the recovery procedure**

```bash
npm test -- tests/runtime-raiders-publication-docs.test.ts tests/companion-installer.test.ts
git add companion/RELEASE docs/runtime-raiders/companion-operations.md tests/companion-installer.test.ts tests/runtime-raiders-publication-docs.test.ts
git commit -m "chore(raiders): advance recovery release sequence"
```

Expected: tests pass, the builder fixture embeds sequence 2, malformed release
identities remain rejected, and the guide does not authorize publication.

---

### Task 4: Run whole-branch verification and freeze the candidate

**Files:**
- Verify: every file changed since design commit `6e60107e74efce29c4c5b750d4abc98c78a1f4c3`
- Reference: `docs/superpowers/specs/2026-08-06-runtime-raiders-publication-recovery-design.md`

**Interfaces:**
- Produces: one reviewed clean sequence-2 Git SHA.
- Consumed by: Task 5 as the sole allowed `--release-sha` value.

- [ ] **Step 1: Run shell syntax and focused gates**

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
npm test -- tests/runtime-raiders-artifacts.test.ts tests/runtime-raiders-publication-docs.test.ts tests/companion-installer.test.ts
```

Expected: syntax exits `0`; focused Vitest reports zero failed tests.

- [ ] **Step 2: Run the complete Swift companion suite**

```bash
cd companion
swift test --quiet
```

Expected: zero failed Swift tests. Return to the repository root afterward.

- [ ] **Step 3: Run repository typecheck and full Vitest**

```bash
npm run typecheck
npm test -- --reporter=dot
```

Expected: both exit `0`; Vitest reports zero failed files and tests.

- [ ] **Step 4: Review the whole diff against the design**

```bash
git diff --check 6e60107e74efce29c4c5b750d4abc98c78a1f4c3...HEAD
git diff --stat 6e60107e74efce29c4c5b750d4abc98c78a1f4c3...HEAD
git status --short --branch
```

Read the actual diff and require all of these:

- four fixed artifact URLs and exact bounds are present;
- public availability gets at most five attempts with exact timeouts;
- deterministic content failures are not retried;
- headers are parsed as fields rather than loose substrings;
- success stdout contains only stable status fields;
- stderr cannot contain bodies, raw header blocks, paths, credentials,
  environment values, or provider data;
- rollback, out-of-band race refusal, immutable preservation, and cleanup tests
  remain;
- Caddy, Node, DB, scoring, adapters, and collection behavior are unchanged;
- `companion/RELEASE` is sequence 2, version `0.2.0`, protocol `1`; and
- no sequence-1 artifact or operator record changed.

- [ ] **Step 5: Record the exact clean candidate SHA**

```bash
git status --porcelain --untracked-files=all
git rev-parse HEAD
git show -s --format='%H%n%s' HEAD
```

Expected: status prints nothing and both identity commands report the same
40-lowercase-hex SHA. Any later source commit invalidates this candidate and
requires repeating Task 4.

---

### Task 5: Build, validate, and record the signed sequence-2 quartet

**Files:**
- Create: `dist/sequence-2-${RR_RELEASE_SHA}/install.sh`
- Create: `dist/sequence-2-${RR_RELEASE_SHA}/runtime-raiders-agent.zip`
- Create: `dist/sequence-2-${RR_RELEASE_SHA}/runtime-raiders-agent.zip.sha256`
- Create: `dist/sequence-2-${RR_RELEASE_SHA}/runtime-raiders-agent.update.json`
- Create: `dist/runtime-raiders-sequence-2-${RR_RELEASE_SHORT}.txt`

**Interfaces:**
- Consumes: exact Task-4 SHA and existing external
  `RUNTIME_RAIDERS_CODESIGN_IDENTITY`, `RUNTIME_RAIDERS_NOTARY_PROFILE`, and
  `RUNTIME_RAIDERS_TEAM_ID`.
- Produces: exact release SHA, version, sequence, protocol, and four digests for
  a later publication authorization.
- Does not produce: push, Pi checkout, public selector, installation, update,
  collection change, or office activation.

- [ ] **Step 1: Reconfirm signing identity without printing secrets**

```bash
test -n "$RUNTIME_RAIDERS_CODESIGN_IDENTITY"
test -n "$RUNTIME_RAIDERS_NOTARY_PROFILE"
test -n "$RUNTIME_RAIDERS_TEAM_ID"
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE"
```

Expected: the Developer ID Application identity is valid and notarytool
authenticates. Do not echo the profile, Team ID, credentials, or environment.

- [ ] **Step 2: Build from the exact clean candidate**

```bash
RR_RELEASE_SHA="$(git rev-parse HEAD)"
RR_RELEASE_SHORT="$(printf '%s' "$RR_RELEASE_SHA" | cut -c1-7)"
RR_RELEASE_OUTPUT="$PWD/dist/sequence-2-$RR_RELEASE_SHA"
RR_RELEASE_SCRATCH="$(mktemp -d /private/tmp/runtime-raiders-sequence-2.XXXXXX)"
test -z "$(git status --porcelain --untracked-files=all)"
scripts/release/build-runtime-raiders-agent.sh \
  --release-sha "$RR_RELEASE_SHA" \
  --output "$RR_RELEASE_OUTPUT" \
  --scratch-path "$RR_RELEASE_SCRATCH"
```

Expected: universal build, codesign, notarization, stapling, and archive
validation succeed; one quartet is transactionally emitted. This does not
contact the Pi.

- [ ] **Step 3: Require exactly four regular artifacts and derive digests**

```bash
find "$RR_RELEASE_OUTPUT" -mindepth 1 -maxdepth 1 -print | sort
test "$(find "$RR_RELEASE_OUTPUT" -mindepth 1 -maxdepth 1 -type f ! -type l | wc -l | tr -d ' ')" = 4
RR_INSTALLER_SHA256="$(shasum -a 256 "$RR_RELEASE_OUTPUT/install.sh" | awk 'NR == 1 {print $1}')"
RR_ZIP_SHA256="$(shasum -a 256 "$RR_RELEASE_OUTPUT/runtime-raiders-agent.zip" | awk 'NR == 1 {print $1}')"
RR_CHECKSUM_SHA256="$(shasum -a 256 "$RR_RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256" | awk 'NR == 1 {print $1}')"
RR_UPDATE_MANIFEST_SHA256="$(shasum -a 256 "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json" | awk 'NR == 1 {print $1}')"
```

Expected filenames are exactly the installer, ZIP, checksum, and update
manifest. Require each digest to match `^[0-9a-f]{64}$` before recording it.

- [ ] **Step 4: Validate checksum and manifest bindings**

```bash
test "$(/usr/bin/sed -n '1p' "$RR_RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256")" = "$RR_ZIP_SHA256  runtime-raiders-agent.zip"
test "$(/usr/bin/wc -l < "$RR_RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256" | tr -d ' ')" = 1
test "$(/usr/bin/plutil -extract companion_version raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = 0.2.0
test "$(/usr/bin/plutil -extract release_sequence raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = 2
test "$(/usr/bin/plutil -extract release_sha raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = "$RR_RELEASE_SHA"
test "$(/usr/bin/plutil -extract update_protocol_version raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = 1
test "$(/usr/bin/plutil -extract zip_sha256 raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = "$RR_ZIP_SHA256"
test "$(/usr/bin/plutil -extract zip_url raw -o - "$RR_RELEASE_OUTPUT/runtime-raiders-agent.update.json")" = 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
```

Expected: every assertion exits `0`. Do not run the installer or extract the ZIP
into an installed application path.

- [ ] **Step 5: Create the owner-only operator record**

Use `apply_patch` to create
`dist/runtime-raiders-sequence-2-${RR_RELEASE_SHORT}.txt` with these exact keys
and the fresh observed values:

```text
record_version=1
release_sha=$RR_RELEASE_SHA
companion_version=0.2.0
release_sequence=2
update_protocol_version=1
installer_sha256=$RR_INSTALLER_SHA256
zip_sha256=$RR_ZIP_SHA256
checksum_sha256=$RR_CHECKSUM_SHA256
update_manifest_sha256=$RR_UPDATE_MANIFEST_SHA256
signing=passed
notarization=passed
stapling=passed
archive_validation=passed
focused_tests=passed
swift_tests=passed
typecheck=passed
vitest=passed
publication=not_authorized
installation=not_authorized
collection=off
```

Resolve every `$RR_*` value to its observed hex string before saving; literal
variable references must not remain. Set mode `0600`, then compute the record's
SHA-256.

- [ ] **Step 6: Present exact identity and stop before production**

Report the full release SHA, version `0.2.0`, sequence `2`, protocol `1`, four
digests, signing/notarization/stapling/archive-validation results, focused/full
test results, and operator-record path/digest. Confirm sequence 1 remains
withdrawn and no push, Pi checkout, selector, publication, installation, update,
collection, or office activation occurred.

Stop and request separately scoped authorization for the exact push/Pi
deployment gate. Do not run `git push`, `ssh`, `scp`, the Pi publisher, an
installer, `raiders update`, or `raiders on` as part of this plan.
