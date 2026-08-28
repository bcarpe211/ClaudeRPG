# Runtime Raiders build-cleanliness implementation plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

**Scope:** Prepare the next release boundary after frozen sequence 10. This work
changes only local release tooling, tests, and the release runbook. It does not
change the sequence-10 artifacts, sign or notarize a replacement, publish,
touch the Pi, update the canary, enable collection, or activate players.

## Approved design

- A Swift scratch path is always builder-owned. A caller may choose the path,
  but it must be initially absent; successful selection transfers cleanup
  responsibility to the builder for success, failure, and signals.
- An omitted agent-builder scratch path is created beneath the builder's
  owner-only temporary work root. The builder never falls back to
  `companion/.build`.
- Before recursive cleanup, each caller-selected scratch path is reduced to one
  validated, absolute physical parent plus one safe leaf. A symlink supplied as
  the parent, unsafe leaves, existing paths, unowned parents, and group- or
  world-writable parents fail before mutation.
- The release-validator builder removes its validated scratch before disabling
  its successful-exit cleanup trap. Its completed output remains intact.
- Temporary validator build state for the private one-time migrator stays in a
  separate owner-only work directory. The immutable private record contains
  only the validator and rendered migrator; the public release record contains
  only the signed quartet.
- Swift's deprecated `--skip-update` remains unchanged in this repair. It may be
  replaced only after a separate test proves offline deterministic resolution.

## Checkpoint 1: red ownership and cleanup tests

Update `tests/companion-installer.test.ts` before production code so it proves:

1. the validator builder removes scratch on success while preserving output;
2. validator failure removes scratch and incomplete output;
3. interruption removes builder-owned scratch;
4. a symlinked or otherwise unsafe scratch parent fails without touching the
   external target;
5. the agent builder's default path leaves neither `companion/.build` nor a
   dirty Git worktree;
6. an explicit initially absent scratch path is removed on success, failure,
   and interruption;
7. the successful public output has exactly the four canonical filenames.

Add the runbook and reproducibility assertions to
`tests/companion-installer.test.ts` so the contract requires cleanup-safe
default building, scratch outside the private record, and exactly the two
canonical private filenames. Run only the focused new tests and record the
expected failures against the old scripts.

## Checkpoint 2: smallest production repair

Change:

- `scripts/release/build-runtime-raiders-release-validator.sh`
- `scripts/release/build-runtime-raiders-agent.sh`

Implement the approved ownership contract, one-time path validation, and
unconditional exact-path cleanup. Collapse the agent builder's two build paths
into one explicit `--scratch-path` route. Do not change signing, notarization,
artifact contents, release identity, update behavior, or installer behavior.

Run the focused red tests until green.

## Checkpoint 3: reproducibility and runbook evidence

Change:

- `scripts/test/runtime-raiders-validator-reproducibility.sh`
- `docs/runtime-raiders-companion-release-gates.md`

Make the reproducibility probe require both scratch directories to be absent
after successful builds. Update Gate 2 to document cleanup-safe default scratch
ownership. Move private validator scratch outside the final record, clean it on
every exit, and assert the final record's exact two filenames. Retain the
immutable `dist/sequence-<n>-<sha>` and four-file public quartet rules.

Run shell syntax checks and the focused release-gate tests.

## Checkpoint 4: local verification only

From the isolated worktree:

1. confirm the worktree starts clean;
2. run the complete installer/release-gate Vitest suites;
3. run validator reproducibility from two different scratch paths;
4. run Gate 1 twice;
5. confirm no `companion/.build`, scratch directory, or other untracked residue
   remains and inspect the exact diff.

Stop with evidence for review. A version/sequence bump, commit, Apple trust
gate, publication, Pi work, and canary update are separate decisions.
