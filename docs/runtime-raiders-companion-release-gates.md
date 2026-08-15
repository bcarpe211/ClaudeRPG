# Runtime Raiders companion release gates

This runbook keeps behavioral failures before Apple trust work and keeps every
external change behind a separate approval. Passing a gate permits review of
the next gate; it never authorizes that gate automatically.

Run release commands only from a clean, frozen commit whose four-line
`companion/RELEASE` record has been reviewed. Release evidence belongs in an
absent immutable directory named `dist/sequence-<n>-<sha>`. A generic
`dist/install.sh` is never release evidence. Collection remains off throughout
these gates unless it receives its own later authorization.

## Gate 1: unsigned local behavior

Run from the repository root before using any Apple credentials:

```sh
npm run typecheck
npm test
npm run canary:migration-preflight
npm run canary:migration-preflight
```

The migration preflight owns a temporary home and scratch directories, keeps
npm offline, checks the public installer, private one-time migrator, builder,
and Gate 2 shell syntax, runs the complete Swift package, and runs the focused
installer, onboarding, publication, and preflight suites. Its sequence-eight
fixtures reproduce the observed `0700` application root, recorded Homebrew
command path and symlinked parent, and exact Runtime Raiders shim target. The
success, near-match, rollback, and crash matrices prove both the one-time
migration and the fresh-install `$HOME/.local/bin/raiders` behavior.

This gate does not read or modify the installed canary. It does not sign,
notarize, contact the Pi or Caddy, publish artifacts, run `raiders on`, enable
collection, or activate players. Run the migration preflight twice from the
same clean SHA; the second pass proves no prior workspace, journal, or partial
transaction is required.

## Gate 2: Apple trust and unpublished signed quartet

Gate 2 requires separate approval because it uses a real Developer ID identity
and Apple notarization. It creates exactly four local artifacts and leaves them
unpublished. With the three release variables already stored outside Git, run:

```sh
/bin/bash scripts/release/run-runtime-raiders-gate2.sh
```

The explicit /bin/bash invocation selects the checked-in script's interpreter;
the Markdown language fence only controls highlighting.

The builder signs, notarizes, staples, validates, and atomically creates the
immutable quartet. The reviewer then requires exactly those four safe local
files, enforces the shared installer-size contract, checks the canonical
checksum and update manifest, binds the quartet to the clean reviewed SHA,
rebuilds the deterministic validator, and requires `install.sh` to match the
reviewed rendering byte-for-byte. It verifies Developer ID requirements, Team
ID, bundle identities, universal architectures, Gatekeeper assessments, and
stapled tickets. The builder owns an initially absent Swift scratch path and
removes it on success, failure, or interruption. Omitting `--scratch-path` is
the cleanup-safe release behavior: scratch stays beneath the builder's private
temporary root and `companion/.build` is never used.

The bounded behavioral portion checks the real signed launcher against active,
fallback, held-trial, missing, malformed, unsafe-mode, symlink, and
identity-mismatch release states, then performs one fresh-install smoke test
with local fake network and launchd boundaries. Gate 2 does not read or copy the
installed canary and does not rerun the sequence-eight migration failure
matrix; that matrix belongs to Gate 1. It does not contact or change the Pi,
publish artifacts, install the canary, enable collection, or activate players.

### Prepare the private sequence-eight migrator record

After Gate 2 passes, prepare—but do not execute—the one-time canary migrator.
This file is not a fifth release artifact. It and its validator must remain
local and unpublished in a separate owner-only directory. Rebuilding and
matching the validator digest proves the private rendering uses the same
deterministic validator embedded in the reviewed public installer:

```sh
/bin/bash scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
```

This explicit Bash boundary executes the reviewed transaction in the repository,
not shell text copied from Markdown. The script prepares and hashes the record;
it never executes the validator or migrator.

Record the two private SHA-256 values beside the four quartet digests. The
rendered migrator digest, exact release identity, and separate execution
approval become the Gate 3 boundary. Gate 2 acceptance alone does not authorize
its execution.

## Gate 3: installed-off one-time migration canary

Gate 3 requires separate approvals for publication of the reviewed quartet and
execution of the exact private migrator digest. Collection must remain
persistently off. Before migration, record only the approved aggregate health,
release identity, enrollment presence, enabled/disabled intent, queue counts,
and protected-state fingerprints.

Execute only the reviewed private script whose SHA-256 matches the Gate 3
approval. A near-match legacy layout must fail without mutation. After a
successful migration, verify:

- the launcher and active agent signatures and exact release identities;
- generation 1 with the new release active and `fallback` and `trial` null;
- `$HOME/.local/bin/raiders` is the canonical command;
- only the proven legacy `/opt/homebrew/opt/libpq/bin/raiders` leaf is gone;
- the flat sequence-eight application remains unchanged as rollback evidence;
- enrollment and protected local state are preserved;
- collection intent remains disabled and the daemon is healthy; and
- there are zero active Runs and zero unexpected queued events.

If the migrator reports recovery rather than success, stop and preserve its
diagnostic evidence; do not improvise cleanup. A Gate 3 pass does not authorize
a normal update, `raiders on`, another canary, or deletion of sequence-eight
support.

## Gate 4: normal protocol-two update canary

Gate 4 requires separate approval to build and publish one subsequent reviewed
release and another approval to run `raiders update` on the installed-off
canary.

Verify the prepared trial, atomic commit, exact active and fallback identities,
release-state generations, protected-state preservation, daemon health, zero
active Runs, queued-event expectations, and preserved collection intent. The
update must retain older releases and remain successful even if cleanup or
journal residue is present.

## Later decisions

Collection remains off through all four release gates unless it receives its
own explicit authorization. `raiders on` and office-wide activation are later,
independent decisions. No test result, commit, merge, signature, notarization,
publication, migration, or update implicitly authorizes either one.
