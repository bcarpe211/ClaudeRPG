# Runtime Raiders zsh-compatible onboarding implementation plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the website-generated Runtime Raiders installer command work unchanged in clean zsh and POSIX sh, and replace shell-ambiguous release-runbook blocks with tested, checked-in Bash entry points.

**Architecture:** Keep `buildCompanionInstallCommand()` as the only player-command generator and make the smallest portable change to its local HTTP-code variable. Exercise the complete generated command under the two supported shells. Move the two substantial operator workflows out of Markdown and into narrow Bash scripts that call the existing builder, reviewer, validator builder, and renderer without changing any release, signing, migration, or publication semantics.

**Tech Stack:** TypeScript, Vitest, POSIX sh, Bash 3.2-compatible shell, zsh, Git fixture repositories, existing Runtime Raiders release tooling.

## Global constraints

- Do not modify or rebuild accepted sequence 10 (`c04214c6ead5d6bcffc06ab6bbbbf4af407360ae`) or accepted sequence 11 (`142302746462aa4da03d04af23fa468631f4a9c3`) artifacts.
- Do not bump `companion/RELEASE`, sign, notarize, publish, contact or modify the Pi, install or migrate a companion, run `raiders on`, enable collection, or activate the office.
- Write each behavioral test first, run it against the current implementation, and record the expected failure before changing production code.
- Preserve every existing installer validation: fixed HTTPS origin, no redirects, shared size cap, regular nonsymlink leaf, current-user ownership, mode `0600`, one link, nonempty content, syntax check, and cleanup.
- Do not rename `status` merely because it occurs inside a script with an explicit `#!/bin/sh`, `#!/bin/bash`, `/bin/sh`, or `/bin/bash` boundary.
- Keep the implementation worktree free of `dist`, `companion/.build`, Swift scratch, test dependency links, and test asset links when verification finishes.

---

## Checkpoint 1: prove and repair the player command in both shells

**Files:**

- Modify: `tests/runtime-raiders-onboarding.test.ts`
- Modify: `tests/web-registration.test.ts`
- Modify: `tests/web-runs.test.ts`
- Modify: `src/web/companion-install.ts`

### 1.1 Add the two-shell behavioral matrix first

- [ ] Add this matrix near the top of `tests/runtime-raiders-onboarding.test.ts`:

```ts
const commandShells = [
  {
    name: 'sh',
    executable: '/bin/sh',
    args: (command: string) => ['-c', command],
  },
  {
    name: 'zsh',
    executable: '/bin/zsh',
    args: (command: string) => ['-f', '-c', command],
  },
] as const;
```

- [ ] Replace the current `/bin/sh`-only complete-command cases with `it.each(commandShells)` cases. For each shell, execute the exact result of `buildCompanionInstallCommand({ curlPath })` and cover:

  1. a valid installer larger than 1 MiB and at most 8 MiB executes once;
  2. curl exits nonzero;
  3. curl exits zero but prints a non-`200` code;
  4. curl leaves a completed file larger than the shared size bound;
  5. curl replaces the temporary leaf with a symlink.

- [ ] Make the fake curl record the exact generated `--output` value without weakening the command under test:

```sh
printf '%s\n' "$output" > "$RR_TEST_OUTPUT_RECORD"
```

  After every success or failure, read that record and assert `existsSync(downloadPath)` is false. Every failure also asserts the installer sentinel is absent and the process status is nonzero.

- [ ] Keep the large success fixture derived from the shared contract. Assert it is `> 1_048_576` and `<= artifactContract.installer_max_bytes`; do not duplicate `8_388_608` in new test behavior.

  Import the same JSON contract used by the generator:

```ts
import artifactContract from '../config/runtime-raiders-artifact-contract.json';
```

- [ ] Add direct generator assertions:

```ts
const command = buildCompanionInstallCommand();
expect(command).toContain('download_http_code=');
expect(command).toContain('[ "$download_http_code" = 200 ]');
expect(command).not.toMatch(/(?:^|[ ;])status=/);
```

### 1.2 Bind both routes to the portable command

- [ ] In `tests/web-registration.test.ts` and the enrollment response test in `tests/web-runs.test.ts`, require:

```ts
expect(installCommand).toContain('[ "$download_http_code" = 200 ]');
expect(installCommand).not.toContain('[ "$status" = 200 ]');
```

### 1.3 Run the red tests

- [ ] Run:

```sh
/Users/carp/Code/ClaudeRPG/node_modules/.bin/vitest run \
  tests/runtime-raiders-onboarding.test.ts \
  tests/web-registration.test.ts \
  tests/web-runs.test.ts
```

Expected red evidence before production change:

- zsh success exits nonzero and reports `read-only variable: status`;
- portable-variable route/generator assertions fail;
- sh behavior otherwise remains unchanged.

### 1.4 Make the minimal generator change

- [ ] In `src/web/companion-install.ts`, change only the generated assignment and comparison:

```ts
`download_http_code="$(${shellQuote(curlPath)} --fail --silent --show-error`,
// existing curl arguments remain byte-for-byte unchanged
')"',
'&& [ "$download_http_code" = 200 ]',
```

- [ ] Re-run the focused command from 1.3. Expected: all parameterized sh/zsh and route tests pass.

- [ ] Inspect `git diff -- src/web/companion-install.ts tests/runtime-raiders-onboarding.test.ts tests/web-registration.test.ts tests/web-runs.test.ts` and confirm no installer policy changed.

- [ ] Commit this checkpoint:

```sh
git add src/web/companion-install.ts \
  tests/runtime-raiders-onboarding.test.ts \
  tests/web-registration.test.ts \
  tests/web-runs.test.ts
git commit -m "fix: make onboarding command portable to zsh"
```

---

## Checkpoint 2: make documentation consume the exact generated command

**Files:**

- Modify: `tests/runtime-raiders-publication-docs.test.ts`
- Modify: `docs/runtime-raiders/companion-operations.md`

### 2.1 Add an exact documentation drift test first

- [ ] Add `<!-- runtime-raiders-canonical-install-command:start -->` immediately before the existing `sh` fence containing the single routine-install command and `<!-- runtime-raiders-canonical-install-command:end -->` immediately after it. Keep exactly one nonempty command line inside that fence.

- [ ] In `tests/runtime-raiders-publication-docs.test.ts`, extract exactly one nonempty line between the markers and compare it to the generator:

```ts
function canonicalInstallCommandFromOperations(): string {
  const match = operations.match(
    /<!-- runtime-raiders-canonical-install-command:start -->\s*```sh\s*([^\n]+)\s*```\s*<!-- runtime-raiders-canonical-install-command:end -->/,
  );
  expect(match).not.toBeNull();
  return match![1];
}

expect(canonicalInstallCommandFromOperations()).toBe(
  buildCompanionInstallCommand(),
);
expect(canonicalInstallCommandFromOperations()).not.toMatch(
  /(?:^|[ ;])status=/,
);
```

### 2.2 Run red, update the one canonical line, and rerun

- [ ] Run:

```sh
/Users/carp/Code/ClaudeRPG/node_modules/.bin/vitest run \
  tests/runtime-raiders-publication-docs.test.ts
```

Expected red evidence: the old documented `status` command does not equal the generator and/or the markers are not yet present.

- [ ] Replace only the marked command with the exact default output of `buildCompanionInstallCommand()` after Checkpoint 1. Preserve the download-to-owner-only-temporary-file flow and keep literal `curl | sh` absent.

- [ ] Re-run the focused test. Expected: pass.

- [ ] Commit this checkpoint:

```sh
git add docs/runtime-raiders/companion-operations.md \
  tests/runtime-raiders-publication-docs.test.ts
git commit -m "docs: bind onboarding command to its generator"
```

---

## Checkpoint 3: replace the inline Gate 2 build block with a tested Bash entry point

**Files:**

- Create: `scripts/release/run-runtime-raiders-gate2.sh`
- Create: `tests/runtime-raiders-release-runners.test.ts`

### 3.1 Add a disposable-repository test first

- [ ] Create a test fixture that:

  - initializes a temporary Git repository;
  - copies the proposed runner into `scripts/release/` once it exists;
  - writes tracked `companion/RELEASE` data;
  - writes executable fake builder and reviewer scripts at the exact production paths;
  - ignores only `/dist/`;
  - commits the fixture and records its `HEAD`;
  - supplies dummy nonempty signing, notary-profile, and 10-character Team ID variables.

- [ ] The fake builder must validate `--release-sha <fixture HEAD> --output <repo>/dist/sequence-11-<fixture HEAD>`, create exactly these four files, and append one call record:

```text
install.sh
runtime-raiders-agent.zip
runtime-raiders-agent.zip.sha256
runtime-raiders-agent.update.json
```

- [ ] The fake reviewer must validate the quartet directory, append one call record, and exit zero.

- [ ] Add tests proving:

  1. success creates the exact immutable output, calls builder then reviewer once, and prints four SHA-256 lines;
  2. a dirty tracked or untracked worktree fails before either fake is called;
  3. a pre-existing output path fails before either fake is called;
  4. a missing required environment variable exits `64` before either fake is called.

- [ ] Run the new test file and record the expected red failure because `scripts/release/run-runtime-raiders-gate2.sh` does not exist:

```sh
/Users/carp/Code/ClaudeRPG/node_modules/.bin/vitest run \
  tests/runtime-raiders-release-runners.test.ts
```

### 3.2 Implement only the orchestration wrapper

- [ ] Create an executable Bash script with this contract:

```bash
#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

[ -n "${RUNTIME_RAIDERS_CODESIGN_IDENTITY:-}" ] || {
  printf 'RUNTIME_RAIDERS_CODESIGN_IDENTITY is required\n' >&2
  exit 64
}
[ -n "${RUNTIME_RAIDERS_NOTARY_PROFILE:-}" ] || {
  printf 'RUNTIME_RAIDERS_NOTARY_PROFILE is required\n' >&2
  exit 64
}
[ -n "${RUNTIME_RAIDERS_TEAM_ID:-}" ] || {
  printf 'RUNTIME_RAIDERS_TEAM_ID is required\n' >&2
  exit 64
}
test -z "$(/usr/bin/git status --porcelain --untracked-files=all)"

RELEASE_SHA="$(/usr/bin/git rev-parse HEAD)"
COMPANION_VERSION="$(sed -n 's/^companion_version=//p' companion/RELEASE)"
RELEASE_SEQUENCE="$(sed -n 's/^release_sequence=//p' companion/RELEASE)"
UPDATE_PROTOCOL_VERSION="$(sed -n 's/^update_protocol_version=//p' companion/RELEASE)"
RELEASE_OUTPUT="$ROOT/dist/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"

/bin/mkdir -p "$ROOT/dist"
test ! -e "$RELEASE_OUTPUT" && test ! -L "$RELEASE_OUTPUT"
scripts/release/build-runtime-raiders-agent.sh \
  --release-sha "$RELEASE_SHA" \
  --output "$RELEASE_OUTPUT"
RUNTIME_RAIDERS_CODESIGN_IDENTITY="$RUNTIME_RAIDERS_CODESIGN_IDENTITY" \
  /bin/bash scripts/test/verify-runtime-raiders-signed-release.sh "$RELEASE_OUTPUT"
/usr/bin/shasum -a 256 \
  "$RELEASE_OUTPUT/install.sh" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.update.json"
```

  Keep identity validation and artifact review in the existing builder/reviewer; do not duplicate them in the wrapper. The parsed version/protocol variables may be retained as explicit release-identity evidence even though the builder performs final validation.

- [ ] Make the script executable, rerun the focused runner tests, and run `/bin/bash -n scripts/release/run-runtime-raiders-gate2.sh`.

- [ ] Commit this checkpoint:

```sh
git add scripts/release/run-runtime-raiders-gate2.sh \
  tests/runtime-raiders-release-runners.test.ts
git commit -m "release: add checked-in Gate 2 runner"
```

---

## Checkpoint 4: replace private-record preparation with a tested Bash entry point

**Files:**

- Create: `scripts/release/prepare-runtime-raiders-sequence8-private-record.sh`
- Modify: `tests/runtime-raiders-release-runners.test.ts`

### 4.1 Add private-record fixture tests first

- [ ] Extend the disposable repository fixture with:

  - an exact four-file `dist/sequence-11-<HEAD>` directory;
  - `install.sh` containing one valid `RELEASE_VALIDATOR_SHA256='<digest>'` assignment;
  - executable fake validator-builder and renderer scripts at their production paths;
  - a tracked `companion/legacy-sequence8/migrate.sh` template;
  - a test-owned call log.

- [ ] Make the fake validator builder write known bytes whose SHA-256 matches the embedded public digest. Make the fake renderer write a syntax-valid migration script.

- [ ] Add tests proving:

  1. success atomically creates `dist/private-sequence-8-11-<HEAD>` containing exactly `runtime-raiders-release-validator` and `migrate-sequence-8.sh` and prints two hashes;
  2. the validator scratch lives outside the final private directory;
  3. renderer failure leaves no final private record and no `.private-sequence-8-work.*` residue;
  4. validator-digest mismatch leaves no final record or work residue;
  5. pre-existing private output fails before either fake is called;
  6. dirty Git state fails before either fake is called;
  7. sending `TERM` while the fake renderer is blocked exits nonzero and removes the exact owned work directory without creating the final record.

- [ ] Run the focused file and record the expected red failure because the private-record script does not exist.

### 4.2 Move the reviewed runbook transaction into Bash

- [ ] Create an executable `#!/bin/bash` script with `set -euo pipefail`. Preserve the current runbook transaction, with these explicit corrections:

  - derive `ROOT`, `HEAD`, and the four release fields from tracked source;
  - require a clean worktree and a present exact public quartet;
  - require the immutable private output to be absent;
  - use `umask 077` and create work only as `dist/.private-sequence-8-work.XXXXXX`;
  - name the cleanup result `cleanup_result`, validate the exact work-path prefix, ownership, directory type, and nonsymlink state before removal;
  - build validator scratch at `$PRIVATE_WORK/validator-scratch`, not beneath `$PRIVATE_STAGE`;
  - compare its SHA-256 to the exact 64-lowercase-hex value embedded in public `install.sh`;
  - render and `/bin/sh -n` the migration script;
  - prove the stage contains exactly two regular nonsymlink files;
  - atomically move the stage to the private output, prove the final file set again, and print its two hashes;
  - never execute either the validator or the migrator.

- [ ] Rerun `tests/runtime-raiders-release-runners.test.ts` and syntax-check both new scripts.

- [ ] Commit this checkpoint:

```sh
git add scripts/release/prepare-runtime-raiders-sequence8-private-record.sh \
  tests/runtime-raiders-release-runners.test.ts
git commit -m "release: add private sequence-eight record runner"
```

---

## Checkpoint 5: shrink the runbook and lock interpreter boundaries

**Files:**

- Modify: `docs/runtime-raiders-companion-release-gates.md`
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `tests/runtime-raiders-sequence8-preflight.test.ts`
- Modify: `tests/runtime-raiders-publication-docs.test.ts`
- Modify: `scripts/test/runtime-raiders-sequence8-preflight.sh`

### 5.1 Add runbook and syntax expectations first

- [ ] Update tests before documentation. Require the Gate 2 section to contain exactly these invocations:

```text
/bin/bash scripts/release/run-runtime-raiders-gate2.sh
/bin/bash scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
```

- [ ] Reject the former inline implementation markers from the runbook:

```ts
expect(gate2).not.toContain('cleanup_private_work()');
expect(gate2).not.toContain('scripts/release/build-runtime-raiders-agent.sh \\\n');
```

- [ ] Require `scripts/test/runtime-raiders-sequence8-preflight.sh` to syntax-check both new entry points:

```sh
bash -n scripts/release/run-runtime-raiders-gate2.sh
bash -n scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
```

- [ ] Add a narrow audit assertion over the directly pasted canonical onboarding command and the two release-runbook invocation lines. Reject `status=` there, but do not scan bodies of explicitly interpreted repository scripts.

- [ ] Treat the HTTPS verification block in `docs/RUNTIME_RAIDERS_CUTOVER.md` as another directly pasted surface. Add a test that its `download_exact_https()` function assigns and compares `download_http_code`, not zsh's read-only `status` parameter. This is a portable variable rename in pasted command text, not a mechanical rewrite of an explicitly interpreted script.

- [ ] Run the publication-doc and sequence-8 preflight tests. Expected red: the runbook still contains the inline blocks and preflight lacks the new syntax checks.

### 5.2 Replace the Markdown implementations

- [ ] Replace the entire inline Gate 2 build block with:

```sh
/bin/bash scripts/release/run-runtime-raiders-gate2.sh
```

- [ ] Replace the entire inline private-record block with:

```sh
/bin/bash scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
```

- [ ] Retain the surrounding authorization, output, verification, and non-publication explanations. State that the explicit `/bin/bash` selects the interpreter; a Markdown code-fence does not.

- [ ] In the directly pasted `download_exact_https()` block in `docs/RUNTIME_RAIDERS_CUTOVER.md`, rename only the local shell variable and its comparison:

```sh
download_http_code="$(curl ... --write-out '%{http_code}' "$url")" || return 1
test "$download_http_code" = 200
```

  Preserve every curl option, argument, timeout, bound, URL, and failure behavior.

- [ ] Add the two syntax checks to the preflight script, then rerun:

```sh
/Users/carp/Code/ClaudeRPG/node_modules/.bin/vitest run \
  tests/runtime-raiders-publication-docs.test.ts \
  tests/runtime-raiders-sequence8-preflight.test.ts \
  tests/runtime-raiders-release-runners.test.ts
```

- [ ] Run a targeted pasted-command audit and review each hit rather than mechanically editing it:

```sh
rg -n '(?:^|[ ;])status=' \
  docs src/web \
  --glob '!docs/superpowers/**'
```

Expected: no `status=` remains in active directly pasted onboarding or release-operation surfaces. Any hit inside an explicitly interpreted checked-in script is classified and left unchanged unless independently wrong. Historical design plans and HTTP response object properties such as `response.status` are not shell variables and remain untouched.

- [ ] Commit this checkpoint:

```sh
git add docs/runtime-raiders-companion-release-gates.md \
  docs/RUNTIME_RAIDERS_CUTOVER.md \
  scripts/test/runtime-raiders-sequence8-preflight.sh \
  tests/runtime-raiders-sequence8-preflight.test.ts \
  tests/runtime-raiders-publication-docs.test.ts
git commit -m "docs: make release shell boundaries explicit"
```

---

## Checkpoint 6: behavioral verification and clean handoff

**Files:** verification only; no release metadata or artifact changes.

### 6.1 Run focused static and behavioral checks

- [ ] Run:

```sh
/bin/bash -n scripts/release/run-runtime-raiders-gate2.sh
/bin/bash -n scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
/Users/carp/Code/ClaudeRPG/node_modules/.bin/vitest run \
  tests/runtime-raiders-onboarding.test.ts \
  tests/web-registration.test.ts \
  tests/web-runs.test.ts \
  tests/runtime-raiders-release-runners.test.ts \
  tests/runtime-raiders-publication-docs.test.ts \
  tests/runtime-raiders-sequence8-preflight.test.ts \
  tests/companion-installer.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass; no Apple or network operation occurs.

### 6.2 Run the complete local repository suite

- [ ] If this isolated worktree lacks ignored dependencies/assets, first prove the destination paths are absent. Create only temporary exact symlinks to the main worktree's existing `node_modules` and `assets`, run `npm test`, then remove only those exact symlinks. Never replace a real directory and never modify either target.

- [ ] Run the behavioral Gate 1 preflight from the clean branch:

```sh
npm run canary:migration-preflight
```

Expected: unsigned/local migration preflight passes without signing, notarization, publication, Pi access, installation, migration, or collection.

### 6.3 Audit the final state

- [ ] Run:

```sh
git diff --check
git status --short --branch
find companion -maxdepth 2 -name .build -o -name '*scratch*'
find . -maxdepth 2 -type l -print
```

Expected:

- no whitespace errors;
- only intentional committed source/test/documentation changes;
- no `companion/.build`, scratch, `dist`, temporary dependency link, or temporary asset link;
- accepted sequence-10 and sequence-11 worktrees remain clean and unchanged.

- [ ] Review the complete branch diff against the approved design and specifically confirm:

  - the player command behaves identically under `/bin/sh -c` and `/bin/zsh -f -c`;
  - the old `status` assignment is absent from direct-paste surfaces;
  - the website and operations guide contain one exact canonical command;
  - both operator workflows are explicit Bash scripts and remain local/unpublished;
  - no release metadata or security check changed.

- [ ] Stop and report evidence. Do not freeze a new release SHA, run Apple trust gates, publish, or touch the canary without a new explicit approval.

## Completion criteria

The repair is ready for a later release boundary only when all six checkpoints pass and the worktree is clean. Fresh onboarding and office activation remain blocked until that later SHA is frozen, independently reviewed, signed/notarized outside the Codex sandbox, and accepted through the separately approved canary gates.
