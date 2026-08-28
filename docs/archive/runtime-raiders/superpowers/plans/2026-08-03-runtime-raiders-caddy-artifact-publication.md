# Runtime Raiders Caddy Artifact Publication Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Caddy download boundary and a root-only atomic
release command for the exact signed Runtime Raiders companion triplet.

**Architecture:** Caddy handles only three exact artifact paths from
`/var/lib/runtime-raiders/current` and sends every other request to the existing
Node service. A Bash release manager validates the approved SHA and three
digests, writes an immutable root-owned release plus a private manifest, and
atomically swaps a relative `current` symlink. The existing read-only Pi
preflight proves the empty store and three 404 responses before cutover.

**Tech Stack:** Caddyfile, Bash on Raspberry Pi OS, systemd-managed Caddy,
TypeScript, Node.js, Vitest, temporary filesystem fixtures

## Global Constraints

- Serve exactly `/install.sh`, `/downloads/runtime-raiders-agent.zip`, and
  `/downloads/runtime-raiders-agent.zip.sha256`; never add a wildcard artifact
  route or directory browsing.
- Keep the single site for `raiders.redlattice.com` and
  `clauderpg.redlattice.com`, the single `localhost:8080` reverse proxy, the
  Cloudflare DNS-01 configuration, and public-resolver override.
- Keep the application internal-only; add no listener, public ingress, tunnel,
  object storage, CDN, or port forwarding.
- Use `/var/lib/runtime-raiders` as the production artifact root and a
  root-owned relative `current -> releases/<40-character SHA>` selector.
- Directories are `root:root:0755`; the three published files are
  `root:root:0644`; `.release-manifest` is `root:root:0600`.
- The Caddy service user may read selected artifacts but may not read the
  manifest or modify the store.
- Publication, Caddy preparation, installed-off canary, live canary, and office
  activation remain separate approvals.
- No build, Git, Caddy reload, Node start, or production cutover automatically
  publishes a companion.
- Before cutover, `current` is absent and all three artifact paths return 404.
- After publication, responses use `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- Withdrawal must remain available when the selected release files or manifest
  are damaged; it removes only `current` and never deletes a release.
- Do not read or record the Caddy token, environment contents, enrollment code,
  provider data, artifact contents, or user content.
- Every production-code change follows a witnessed RED-GREEN test cycle.
- Do not deploy, publish artifacts, install companions, push, reload Caddy, or
  change Pi state during implementation.
- Preserve and do not stage `assets`, `companion/.build/`, or
  `docs/runtime-raiders/rebrand-visual-checklist.md`.

## File map

- `deploy/Caddyfile`: exact artifact handlers and unchanged fallback proxy/TLS.
- `scripts/pi/runtime-raiders-artifacts.sh`: root-only publish/status/withdraw
  state machine.
- `scripts/pi/runtime-raiders-preflight.sh`: read-only empty-store and 404
  checks before cutover.
- `tests/deploy-runtime-raiders.test.ts`: static Caddy boundary tests.
- `tests/runtime-raiders-artifacts.test.ts`: real script behavior in isolated
  temporary stores with Linux-command shims.
- `tests/runtime-raiders-preflight.test.ts`: read-only store and HTTPS-404
  preflight tests.
- `tests/runtime-raiders-publication-docs.test.ts`: approval-order and
  operational-document consistency tests.
- `docs/RUNTIME_RAIDERS_CUTOVER.md`: Caddy preparation, publication, acceptance,
  and withdrawal commands.
- `docs/runtime-raiders/cutover-authorization-packet.md`: separate Caddy and
  publication approval statements.
- `docs/runtime-raiders/canary-checklist.md`: unpublished and published release
  gates.
- `docs/runtime-raiders/companion-operations.md`: release-manager operations and
  verified installer flow.
- `docs/BACKLOG.md`: deferred branded 404 page.

---

### Task 1: Add exact fail-closed Caddy artifact handlers

**Files:**
- Modify: `deploy/Caddyfile:1-16`
- Modify: `tests/deploy-runtime-raiders.test.ts:25-76`

**Interfaces:**
- Consumes: the fixed filesystem root `/var/lib/runtime-raiders/current`.
- Produces: three mutually exclusive literal-path handlers plus one matcherless
  fallback to `localhost:8080`.
- Preserves: the two-host site, TLS block, resolver override, and one reverse
  proxy target.

- [ ] **Step 1: Write failing Caddy contract tests**

Add these assertions after the existing host/proxy tests:

```ts
const artifactPaths = [
  '/install.sh',
  '/downloads/runtime-raiders-agent.zip',
  '/downloads/runtime-raiders-agent.zip.sha256',
];

it('serves only the three literal companion paths from the managed selector', () => {
  for (const path of artifactPaths) {
    expect(caddy).toContain(`handle ${path} {`);
  }
  expect(caddy.match(/root \* \/var\/lib\/runtime-raiders\/current/g))
    .toHaveLength(3);
  expect(caddy.match(/\bfile_server\b/g)).toHaveLength(3);
  expect(caddy).not.toMatch(/handle(?:_path)?\s+\/downloads\/\*/);
  expect(caddy).not.toMatch(/\bfile_server\s+browse\b/);
});

it('marks every companion response non-cacheable and non-sniffable', () => {
  expect(caddy.match(/header Cache-Control "no-store"/g)).toHaveLength(3);
  expect(caddy.match(/header X-Content-Type-Options "nosniff"/g))
    .toHaveLength(3);
  expect(caddy).toContain('header Content-Type "text/x-shellscript; charset=utf-8"');
  expect(caddy).toContain('header Content-Type "application/zip"');
  expect(caddy).toContain('header Content-Type "text/plain; charset=utf-8"');
});

it('keeps artifact handling ahead of one matcherless app fallback', () => {
  const fallback = caddy.indexOf('handle {\n\t\treverse_proxy localhost:8080');
  expect(fallback).toBeGreaterThan(caddy.indexOf('handle /install.sh {'));
  expect(fallback).toBeGreaterThan(
    caddy.indexOf('handle /downloads/runtime-raiders-agent.zip.sha256 {'),
  );
  expect(caddy.match(/handle \{\n\t\treverse_proxy localhost:8080/g))
    .toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/deploy-runtime-raiders.test.ts
```

Expected: the three new tests fail because the Caddyfile contains only the
top-level reverse proxy.

- [ ] **Step 3: Implement the literal Caddy handlers**

Replace the top-level proxy with these four sibling `handle` blocks. Keep the
existing TLS and `encode zstd gzip` directives unchanged:

```caddyfile
	handle /install.sh {
		header Cache-Control "no-store"
		header X-Content-Type-Options "nosniff"
		header Content-Type "text/x-shellscript; charset=utf-8"
		root * /var/lib/runtime-raiders/current
		file_server
	}

	handle /downloads/runtime-raiders-agent.zip {
		header Cache-Control "no-store"
		header X-Content-Type-Options "nosniff"
		header Content-Type "application/zip"
		root * /var/lib/runtime-raiders/current
		file_server
	}

	handle /downloads/runtime-raiders-agent.zip.sha256 {
		header Cache-Control "no-store"
		header X-Content-Type-Options "nosniff"
		header Content-Type "text/plain; charset=utf-8"
		root * /var/lib/runtime-raiders/current
		file_server
	}

	handle {
		reverse_proxy localhost:8080
	}
```

Do not add `pass_thru`: an absent selected artifact must stop at Caddy with a
404 instead of falling through to Node.

- [ ] **Step 4: Run the Caddy contract test and verify GREEN**

Run:

```bash
npx vitest run tests/deploy-runtime-raiders.test.ts
```

Expected: all deployment tests pass, including one site, one upstream, and no
public ingress.

- [ ] **Step 5: Commit Task 1**

```bash
git add deploy/Caddyfile tests/deploy-runtime-raiders.test.ts
git commit -m "ops(raiders): add fail-closed artifact routes"
```

---

### Task 2: Build the immutable release store and content-free status command

**Files:**
- Create: `scripts/pi/runtime-raiders-artifacts.sh`
- Create: `tests/runtime-raiders-artifacts.test.ts`

**Interfaces:**
- Consumes: `publish --source DIR --release-sha SHA --installer-sha256 SHA256
  --zip-sha256 SHA256 --checksum-sha256 SHA256`.
- Produces: an immutable `releases/<SHA>` directory, version-1 private manifest,
  atomically selected `current` symlink, and content-free status output.
- Test environment: `RUNTIME_RAIDERS_TEST_MODE=1` and
  `RUNTIME_RAIDERS_ARTIFACT_ROOT=<temporary directory>`.

- [ ] **Step 1: Create the fixture and write the first failing publication test**

Create a temporary source containing a rendered installer and canonical
triplet, using Node's real SHA-256 implementation:

```ts
const SCRIPT = resolve('scripts/pi/runtime-raiders-artifacts.sh');
const releaseSha = 'b'.repeat(40);

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceTriplet(root: string) {
  const source = join(root, 'source');
  mkdirSync(source);
  const installer = join(source, 'install.sh');
  const zip = join(source, 'runtime-raiders-agent.zip');
  const checksum = join(source, 'runtime-raiders-agent.zip.sha256');
  writeFileSync(installer, [
    '#!/bin/sh',
    "ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'",
    "CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'",
    "TEAM_ID='ABCDE12345'",
    '',
  ].join('\n'));
  writeFileSync(zip, 'signed-test-archive');
  writeFileSync(checksum, `${sha256(zip)}  runtime-raiders-agent.zip\n`);
  return { source, installer, zip, checksum };
}
```

The fixture creates `artifactRoot/releases` with mode `0755` plus executable
test shims for `id`, `install`, `stat`, `sha256sum`, `chown`, and `mv`. The shims
must:

```sh
# id
test "$1" = -u && printf '0\n'

# sha256sum
exec /usr/bin/shasum -a 256 "$@"

# stat: preserve the real BSD mode but report root ownership to the Linux script
test "$1" = -c && test "$3" = --
case "$2" in
  '%u:%g:%a') mode=$(/usr/bin/stat -f %Lp "$4"); printf '0:0:%s\n' "$mode" ;;
  '%u:%g') printf '0:0\n' ;;
  *) exit 64 ;;
esac
```

The `install` shim removes `-o root -g root`, preserves `-m`, and delegates file
or directory creation to `/usr/bin/install`. It logs every call so the test can
assert that production ownership flags were requested. The `chown` shim logs
and succeeds; the `mv` shim logs, removes a Linux-only `--` argument, supports
fault injection, and delegates to `/bin/mv`.

Invoke the real script with:

```ts
const args = [
  'publish',
  '--source', files.source,
  '--release-sha', releaseSha,
  '--installer-sha256', sha256(files.installer),
  '--zip-sha256', sha256(files.zip),
  '--checksum-sha256', sha256(files.checksum),
];
const result = spawnSync('bash', [SCRIPT, ...args], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${fakes}:/usr/bin:/bin`,
    RUNTIME_RAIDERS_TEST_MODE: '1',
    RUNTIME_RAIDERS_ARTIFACT_ROOT: artifactRoot,
    RUNTIME_RAIDERS_TEST_LOG: commandLog,
  },
});
```

Assert exit `0`, `current` equals `releases/${releaseSha}`, all three bytes match,
directory/file modes are exact, the manifest is mode `0600`, and output contains
only these lines:

```text
active_release=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
installer_sha256=<calculated installer digest>
zip_sha256=<calculated ZIP digest>
checksum_sha256=<calculated checksum-file digest>
```

- [ ] **Step 2: Run the artifact test and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: FAIL because `scripts/pi/runtime-raiders-artifacts.sh` does not exist.

- [ ] **Step 3: Implement argument parsing and fixed/test roots**

Start the script with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

PRODUCTION_ROOT=/var/lib/runtime-raiders
ARTIFACT_ROOT=$PRODUCTION_ROOT
if [[ ${RUNTIME_RAIDERS_TEST_MODE:-0} == 1 ]]; then
  ARTIFACT_ROOT=${RUNTIME_RAIDERS_ARTIFACT_ROOT:?test artifact root is required}
fi
RELEASES=$ARTIFACT_ROOT/releases
CURRENT=$ARTIFACT_ROOT/current
```

Define and use these exact helpers:

```bash
die() { printf 'runtime-raiders-artifacts: %s\n' "$1" >&2; exit 1; }
require_root() { test "$(id -u)" = 0 || die 'root is required'; }
require_release_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]] || die 'invalid release SHA'; }
require_digest() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || die "invalid $2 SHA-256"; }
sha256_file() { sha256sum -- "$1" | awk 'NR == 1 && NF >= 1 { print $1; exit }'; }
metadata() { stat -c '%u:%g:%a' -- "$1"; }
```

`publish` requires every named option exactly once and rejects extra arguments.
`status` accepts no options. `withdraw` is added in Task 3.

- [ ] **Step 4: Implement the first atomic publication path**

Require `ARTIFACT_ROOT` and `RELEASES` to be nonsymlink directories with
metadata `0:0:755`. Acquire a same-filesystem lock with:

```bash
LOCK=$ARTIFACT_ROOT/.publication.lock
mkdir -- "$LOCK" || die 'publication is already in progress'
STAGE=''
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if test -n "$STAGE"; then
    case "$STAGE" in
      "$ARTIFACT_ROOT"/.stage.*) rm -rf -- "$STAGE" ;;
      *) printf 'refusing unsafe staging cleanup\n' >&2; status=1 ;;
    esac
  fi
  rmdir -- "$LOCK" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
```

After source validation, create staging beneath `ARTIFACT_ROOT`, use
`install -d -o root -g root -m 0755` for directories, and
`install -o root -g root -m 0644` for the three files. Write the manifest with:

```bash
printf '%s\n' \
  'version=1' \
  "release_sha=$RELEASE_SHA" \
  "installer_sha256=$INSTALLER_SHA256" \
  "zip_sha256=$ZIP_SHA256" \
  "checksum_sha256=$CHECKSUM_SHA256" > "$STAGED_RELEASE/.release-manifest"
chown root:root "$STAGED_RELEASE/.release-manifest"
chmod 0600 "$STAGED_RELEASE/.release-manifest"
```

Recalculate the staged digests, then rename the complete staged release to
`$RELEASES/$RELEASE_SHA`. Create `$ARTIFACT_ROOT/.current.$$` as a relative
symlink to `releases/$RELEASE_SHA` and rename it over `current`. All paths must
remain beneath the validated fixed root.

- [ ] **Step 5: Implement manifest-backed status**

Implement `validate_release DIRECTORY EXPECTED_SHA` to require exact file types,
ownership, modes, manifest keys, canonical checksum content, and calculated
digests. `status` prints `unpublished` when both `test ! -e "$CURRENT"` and
`test ! -L "$CURRENT"` succeed. Otherwise it accepts only a relative selector
matching `releases/<40 lowercase hexadecimal characters>`, validates that
release, and prints the four content-free fields shown in Step 1.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: syntax check succeeds and the initial publish/status tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add scripts/pi/runtime-raiders-artifacts.sh tests/runtime-raiders-artifacts.test.ts
git commit -m "ops(raiders): add atomic artifact publication"
```

---

### Task 3: Harden publication failure behavior and add exact withdrawal

**Files:**
- Modify: `scripts/pi/runtime-raiders-artifacts.sh`
- Modify: `tests/runtime-raiders-artifacts.test.ts`

**Interfaces:**
- Consumes: the release store and helper contracts from Task 2.
- Produces: fail-closed validation, immutable reselection, preserved prior
  selector on every failure, and `withdraw --release-sha SHA`.

- [ ] **Step 1: Add failing table-driven source-validation tests**

Add cases that mutate one valid fixture at a time and expect nonzero status,
unchanged `current`, and no final release directory:

```ts
it.each([
  ['uppercase release SHA', (f) => { f.args[4] = releaseSha.toUpperCase(); }],
  ['short installer digest', (f) => { f.args[6] = 'a'.repeat(63); }],
  ['missing installer', (f) => { unlinkSync(f.files.installer); }],
  ['empty ZIP', (f) => { writeFileSync(f.files.zip, ''); }],
  ['symlinked checksum', (f) => {
    unlinkSync(f.files.checksum);
    symlinkSync(f.files.zip, f.files.checksum);
  }],
  ['unrendered Team ID', (f) => {
    writeFileSync(f.files.installer, "TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'\n");
  }],
  ['wrong artifact URL', (f) => {
    writeFileSync(f.files.installer, readFileSync(f.files.installer, 'utf8')
      .replace('raiders.redlattice.com', 'example.invalid'));
  }],
  ['malformed checksum filename', (f) => {
    writeFileSync(f.files.checksum, `${sha256(f.files.zip)}  other.zip\n`);
  }],
  ['extra checksum line', (f) => {
    appendFileSync(f.files.checksum, 'extra\n');
  }],
])('rejects %s before selecting a release', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  const result = runPublish(f);
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.artifactRoot, 'current'))).toBe(false);
  expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(false);
});
```

Add distinct mismatch tests for all three supplied digests.

- [ ] **Step 2: Run the validation tests and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: at least the symlink, installer-URL, checksum-shape, and supplied
digest cases fail because Task 2 implements only the initial path.

- [ ] **Step 3: Implement complete source and checksum validation**

Require the source directory and each source file to be nonsymlinked. Require
regular, nonempty files. Verify the installer contains exactly one literal
assignment for each documented URL and no Team ID placeholder. Generate the
expected checksum in staging and compare bytes rather than parsing a prefix:

```bash
printf '%s  runtime-raiders-agent.zip\n' "$ZIP_SHA256" > "$STAGE/expected.sha256"
cmp -s -- "$STAGE/expected.sha256" "$SOURCE/runtime-raiders-agent.zip.sha256" ||
  die 'checksum file does not match the approved ZIP'
```

Calculate each source digest before copying and each destination digest after
copying. Every comparison is exact and lowercase.

- [ ] **Step 4: Add failing prior-release and immutable-reselection tests**

Publish release `a...a`, then attempt release `b...b` with a fake `install`,
`mv`, or selector operation configured to fail. Assert the original `current`
target and bytes remain unchanged. Add tests proving:

```ts
expect(runPublish(existingExactFixture).status).toBe(0);
expect(readlinkSync(current)).toBe(`releases/${releaseSha}`);

writeFileSync(existingInstaller, 'tampered');
expect(runPublish(existingMismatchFixture).status).not.toBe(0);
expect(readlinkSync(current)).toBe(`releases/${priorSha}`);
expect(readFileSync(existingInstaller, 'utf8')).toBe('tampered');
```

Also create `.publication.lock` before invocation and assert the script refuses
concurrent publication without changing state.

- [ ] **Step 5: Run the atomicity tests and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: immutable reselection and injected-failure cases fail until the
release validator and cleanup paths are complete.

- [ ] **Step 6: Finish immutable selection and cleanup behavior**

Before staging, if `releases/$RELEASE_SHA` exists, call `validate_release` and
compare all three manifest digests to the command arguments. Select it only on
an exact match. Never write into or remove an existing release directory.

Keep the prior selector untouched until the final selector rename. Cleanup may
remove only the invocation's `mktemp` staging directory, temporary selector,
and lock. It must reject any computed cleanup path outside `ARTIFACT_ROOT`.

- [ ] **Step 7: Add failing status-corruption and withdrawal tests**

Cover malformed selector targets, unsafe selector types, manifest corruption,
non-root selector ownership, wrong modes, missing files, and calculated digest
mismatches. Then add:

```ts
const wrong = run(f, ['withdraw', '--release-sha', priorSha]);
expect(wrong.status).not.toBe(0);
expect(readlinkSync(current)).toBe(`releases/${releaseSha}`);

writeFileSync(selectedZip, 'damaged after publication');
const withdrawn = run(f, ['withdraw', '--release-sha', releaseSha]);
expect(withdrawn.status).toBe(0);
expect(existsSync(current)).toBe(false);
expect(existsSync(releaseDirectory)).toBe(true);
expect(withdrawn.stdout).toBe(`withdrawn_release=${releaseSha}\n`);
```

- [ ] **Step 8: Run the withdrawal tests and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: withdrawal tests fail because the command is not implemented.

- [ ] **Step 9: Implement exact-SHA withdrawal**

Parse exactly `withdraw --release-sha SHA`, acquire the publication lock, and
require `current` to be a symlink whose raw relative target is exactly
`releases/$RELEASE_SHA` and whose `stat -c '%u:%g'` is `0:0`. Do not validate or
follow release files during withdrawal. Create a same-directory tombstone name,
atomically rename `current` to it, then unlink the tombstone. If rename succeeds
but unlink fails, downloads remain withdrawn and the command returns nonzero for
operator cleanup.

- [ ] **Step 10: Run all artifact tests and verify GREEN**

Run:

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
npx vitest run tests/runtime-raiders-artifacts.test.ts
```

Expected: every publish, status, corruption, concurrency, atomicity, immutable
reselection, and withdrawal test passes with no secret/content output.

- [ ] **Step 11: Commit Task 3**

```bash
git add scripts/pi/runtime-raiders-artifacts.sh tests/runtime-raiders-artifacts.test.ts
git commit -m "ops(raiders): harden artifact release rollback"
```

---

### Task 4: Bind the final read-only preflight to an unpublished artifact store

**Files:**
- Modify: `scripts/pi/runtime-raiders-preflight.sh:7-66,140-430`
- Modify: `tests/runtime-raiders-preflight.test.ts:1-240,760-910`

**Interfaces:**
- Extends the preflight CLI with required `--artifact-root PATH`.
- Produces `PASS artifact store` and `PASS artifact routes unpublished` only
  when the empty store and three HTTPS 404s are observed.
- Preserves the existing no-write, no-reload, no-fetch preflight contract.

- [ ] **Step 1: Extend the fixture and add failing store tests**

Create `artifactRoot` and `artifactRoot/releases` as mode `0755`, return it from
`fixture()`, add `--artifact-root` in `run()`, and extend the fake `stat` command
to report root ownership plus real test modes for both directories.

Add these tests:

```ts
it('requires a root-owned empty artifact store before cutover', () => {
  const f = fixture();
  symlinkSync('releases/' + 'b'.repeat(40), join(f.artifactRoot, 'current'));
  const result = run(f);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain('FAIL artifact store');
});

it('rejects missing or symlinked artifact release directories', () => {
  for (const kind of ['missing', 'symlink'] as const) {
    const f = fixture();
    rmSync(join(f.artifactRoot, 'releases'), { recursive: true });
    if (kind === 'symlink') {
      symlinkSync(f.root, join(f.artifactRoot, 'releases'));
    }
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL artifact store');
  }
});

it('rejects a permission-widened artifact root', () => {
  const result = run(fixture(), { FAKE_ARTIFACT_ROOT_MODE: '777' });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain('FAIL artifact store');
});
```

- [ ] **Step 2: Extend the fake HTTPS client and add failing 404 tests**

The fake `curl` returns an HTTP code for the three exact artifact URLs and keeps
the existing success behavior for both health checks:

```sh
case "$*" in
  *https://raiders.redlattice.com/install.sh*|\
  *https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip*|\
  *https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256*)
    printf '%s' "${FAKE_ARTIFACT_HTTP_STATUS:-404}" ;;
  *https://raiders.redlattice.com/health*) test "${FAKE_NEW_HTTPS:-1}" = 1 ;;
  *https://clauderpg.redlattice.com/health*) test "${FAKE_OLD_HTTPS:-1}" = 1 ;;
  *) exit 75 ;;
esac
```

Add a test with `FAKE_ARTIFACT_HTTP_STATUS=200` and expect
`FAIL artifact routes unpublished`.

- [ ] **Step 3: Run the preflight tests and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-preflight.test.ts
```

Expected: the new tests fail because the CLI, store gate, and artifact HTTP
checks do not exist.

- [ ] **Step 4: Implement the read-only store gate**

Add `ARTIFACT_ROOT=''` and parse required `--artifact-root`. Require an absolute
path. Use only `test` and `stat`:

```bash
artifact_store_ok=1
test -d "$ARTIFACT_ROOT" && test ! -L "$ARTIFACT_ROOT" || artifact_store_ok=0
test -d "$ARTIFACT_ROOT/releases" &&
  test ! -L "$ARTIFACT_ROOT/releases" || artifact_store_ok=0
test "$(stat -c '%u:%g:%a' -- "$ARTIFACT_ROOT" 2>/dev/null)" = '0:0:755' ||
  artifact_store_ok=0
test "$(stat -c '%u:%g:%a' -- "$ARTIFACT_ROOT/releases" 2>/dev/null)" = '0:0:755' ||
  artifact_store_ok=0
test ! -e "$ARTIFACT_ROOT/current" && test ! -L "$ARTIFACT_ROOT/current" ||
  artifact_store_ok=0
```

Print only `PASS artifact store` or `FAIL artifact store`.

- [ ] **Step 5: Implement exact external 404 checks**

After hostname/DNS resolution, query each literal URL through the resolved Pi
address with a bounded timeout and no response body:

```bash
artifact_routes_ok=1
for artifact_path in \
  /install.sh \
  /downloads/runtime-raiders-agent.zip \
  /downloads/runtime-raiders-agent.zip.sha256; do
  artifact_status=$(curl --silent --show-error --max-time 10 --output /dev/null \
    --write-out '%{http_code}' --noproxy '*' \
    --resolve "raiders.redlattice.com:443:$resolved_local" \
    "https://raiders.redlattice.com$artifact_path") || artifact_routes_ok=0
  test "$artifact_status" = 404 || artifact_routes_ok=0
done
```

Print only `PASS artifact routes unpublished` or
`FAIL artifact routes unpublished`.

- [ ] **Step 6: Prove the preflight remains read-only and verify GREEN**

Extend the protected-fixture list with `artifactRoot` and its `releases`
directory metadata. Assert the command log still contains no restart, reload,
start, stop, enable, disable, install, copy, move, remove, checkout, fetch, or
database write.

Run:

```bash
bash -n scripts/pi/runtime-raiders-preflight.sh
npx vitest run tests/runtime-raiders-preflight.test.ts
```

Expected: every preflight test passes; ready output now includes both artifact
PASS lines and still ends with `READY separately authorized cutover gates passed`.

- [ ] **Step 7: Commit Task 4**

```bash
git add scripts/pi/runtime-raiders-preflight.sh tests/runtime-raiders-preflight.test.ts
git commit -m "ops(raiders): gate cutover on unpublished artifacts"
```

---

### Task 5: Align the release documents and defer the branded 404

**Files:**
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `docs/runtime-raiders/canary-checklist.md`
- Modify: `docs/runtime-raiders/companion-operations.md`
- Create/modify: `docs/runtime-raiders/cutover-authorization-packet.md`
- Modify: `docs/BACKLOG.md`
- Create: `tests/runtime-raiders-publication-docs.test.ts`

**Interfaces:**
- Consumes: the Caddy and shell interfaces from Tasks 1-4.
- Produces: one consistent sequence with separate updater, repository, Caddy
  preparation, cutover, artifact publication, installed-off, live-canary, and
  office approvals.

- [ ] **Step 1: Write failing documentation-contract assertions**

Create `tests/runtime-raiders-publication-docs.test.ts`. Load the runbook,
authorization packet, canary checklist, companion operations, and backlog with
`readFileSync`. Require every operational document to name the fixed artifact
root where applicable, and require the runbook and companion operations to name
`status`, `publish`, and exact-SHA `withdraw`. Require the authorization packet
to contain these separate headings in order:

```ts
const approvalHeadings = [
  '### A. Updater hold',
  '### B. Exact release publication',
  '### C. Fail-closed Caddy preparation',
  '### D. Production cutover',
  '### E. Signed companion publication',
  '### F. Installed-off canary',
  '### G. Live canary activation',
  '### H. Office activation',
];
let previous = -1;
for (const heading of approvalHeadings) {
  const index = packet.indexOf(heading);
  expect(index).toBeGreaterThan(previous);
  previous = index;
}
```

Assert the packet says Caddy preparation leaves `current` absent and all three
artifact URLs at 404, and that it does not authorize artifact publication.
Assert `docs/BACKLOG.md` contains `Branded Runtime Raiders 404 page` and keeps it
unchecked.

- [ ] **Step 2: Run the documentation-focused tests and verify RED**

Run:

```bash
npx vitest run tests/runtime-raiders-publication-docs.test.ts
```

Expected: FAIL because the Caddy-preparation approval, release-manager commands,
and branded-404 backlog item are absent.

- [ ] **Step 3: Update the authority and cutover sequence**

In `docs/RUNTIME_RAIDERS_CUTOVER.md` and the authorization packet, place the
separately authorized Caddy preparation after the updater hold and exact Git SHA
publication but before final read-only preflight. Record the prior Caddy config
backup and checksum outside Git, install the reviewed Caddyfile, validate using
the manager-loaded environment, reload, verify both health routes at 200, and
verify the three artifact routes at 404. Failure restores the prior Caddy file
and reloads it.

The preparation creates only the empty store with:

```sh
sudo install -d -o root -g root -m 0755 \
  /var/lib/runtime-raiders \
  /var/lib/runtime-raiders/releases
sudo test ! -e /var/lib/runtime-raiders/current
sudo test ! -L /var/lib/runtime-raiders/current
```

Update every preflight example to pass:

```sh
--artifact-root /var/lib/runtime-raiders
```

Do not put the Caddy environment contents or token in the documents.

- [ ] **Step 4: Document publication and withdrawal commands**

After deployed-server acceptance and exact artifact-publication approval, the
runbook stages the triplet in one owner-controlled Pi directory and runs:

```sh
sudo scripts/pi/runtime-raiders-artifacts.sh publish \
  --source "$SOURCE_DIR" \
  --release-sha "$RELEASE_SHA" \
  --installer-sha256 "$INSTALLER_SHA256" \
  --zip-sha256 "$ZIP_SHA256" \
  --checksum-sha256 "$CHECKSUM_SHA256"
sudo scripts/pi/runtime-raiders-artifacts.sh status
```

It downloads each HTTPS response independently, compares all three recorded
digests, checks `no-store` and `nosniff`, and confirms `/health` remains 200.
The rollback command is:

```sh
sudo scripts/pi/runtime-raiders-artifacts.sh withdraw \
  --release-sha "$RELEASE_SHA"
```

After withdrawal, require all three URLs to return 404 and health to remain 200.
Publication and withdrawal do not reload Caddy or restart Node.

- [ ] **Step 5: Update canary and companion operations**

Add checklist rows for:

```text
Caddy release store prepared, selector absent
Artifact routes unpublished, 3/3 return 404
Signed triplet published, 3/3 digests verified
Installed signed artifact, daemon live and persistently off
```

Keep the first canary's locally downloaded, hash-verified installer flow. Keep
the routine office `curl | sh` command only after all preceding gates pass.

- [ ] **Step 6: Backlog the custom 404 page**

Append an unchecked backlog item named `Branded Runtime Raiders 404 page`. It
must preserve HTTP 404, exact artifact matchers, `no-store`, `nosniff`, and the
unpublished-state tests. It must not become an asset dependency for this
release.

- [ ] **Step 7: Run the documentation tests and verify GREEN**

Run:

```bash
npx vitest run tests/runtime-raiders-publication-docs.test.ts
npm run check:player-copy
git diff --check
```

Expected: focused tests and the player-copy guard pass, and the diff check emits
no output.

- [ ] **Step 8: Commit Task 5 without protected paths**

Stage only the listed release documents and tests. Confirm that `assets`,
`companion/.build/`, and `docs/runtime-raiders/rebrand-visual-checklist.md` are
absent from `git diff --cached --name-only`, then commit:

```bash
git add docs/BACKLOG.md docs/RUNTIME_RAIDERS_CUTOVER.md \
  docs/runtime-raiders/canary-checklist.md \
  docs/runtime-raiders/companion-operations.md \
  docs/runtime-raiders/cutover-authorization-packet.md \
  tests/runtime-raiders-publication-docs.test.ts
git commit -m "docs(raiders): gate Caddy artifact publication"
```

---

### Task 6: Complete local release verification without publication

**Files:**
- Verify: `deploy/Caddyfile`
- Verify: `scripts/pi/runtime-raiders-artifacts.sh`
- Verify: `scripts/pi/runtime-raiders-preflight.sh`
- Verify: all modified tests and release documents

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: local evidence for a reviewable final candidate only; it does not
  push, deploy, reload Caddy, upload/publish artifacts, install a companion, or
  alter Pi state.

- [ ] **Step 1: Run shell and focused publication gates**

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh \
  scripts/pi/runtime-raiders-preflight.sh \
  scripts/pi/runtime-raiders-cutover-guards.sh
npx vitest run \
  tests/deploy-runtime-raiders.test.ts \
  tests/runtime-raiders-artifacts.test.ts \
  tests/runtime-raiders-preflight.test.ts \
  tests/runtime-raiders-cutover-guards.test.ts \
  tests/companion-installer.test.ts
```

Expected: shell parsing succeeds and every focused deployment, artifact,
preflight, cutover, and installer test passes.

- [ ] **Step 2: Run the complete repository gate**

```bash
npm test
npm run typecheck
npm run check:player-copy
git diff --check
```

Expected: the complete Vitest suite passes with zero failures, TypeScript emits
no errors, player-copy finds no forbidden copy, and diff-check emits no output.

- [ ] **Step 3: Run privacy and scope scans**

Search the changed files for internal IPs, SSH fingerprints, private-key
markers, literal tokens, enrollment secrets, provider paths, and user content.
Expected: zero findings. Verify the cached diff contains only intended release
mechanism files and that protected untracked paths remain unstaged.

- [ ] **Step 4: Review the implementation against primary Caddy behavior**

Confirm the final Caddyfile uses exact path matchers with no `*`, sibling
mutually exclusive `handle` blocks, a matcherless fallback, and `file_server`
without `pass_thru` or `browse`. These contracts follow:

- `https://caddyserver.com/docs/caddyfile/directives/handle`
- `https://caddyserver.com/docs/caddyfile/matchers`
- `https://caddyserver.com/docs/caddyfile/directives/file_server`

- [ ] **Step 5: Record the implementation checkpoint outside the candidate**

After all tracked implementation and documentation commits are complete, record
the resulting full local commit SHA, focused/full test counts, and remaining
external gates in the restricted operator record and implementation handoff,
not inside the candidate commit. Keep repository status `NO-GO`: Caddy
preparation, final signed rebuild, updater hold, repository publication, Pi
preflight, server cutover, artifact publication, and canaries remain separately
authorized future actions. Do not create an evidence-only commit that would
change the SHA being recorded.
