# Runtime Raiders publication recovery design

**Date:** 2026-08-06

**Status:** Approved design; implementation pending

**Scope:** Recover from the withdrawn sequence-1 companion publication with a
new sequence-2 release and make public artifact verification diagnostic,
complete, bounded, and fail-closed.

## Context

The first updater-capable companion quartet was accepted into the immutable
release store and briefly selected. The in-repository publisher verified its
public ZIP and update manifest, but a separate operator verifier later failed
without identifying the failed assertion. Recovery withdrew the exact selector,
leaving all four public artifact routes at `404` while preserving the immutable
release and source quartet for evidence.

Post-failure inspection proved that the stored sequence-1 quartet and manifest
matched their approved digests, the Caddy routes retained their required
headers, both health paths remained available, the production service remained
healthy and paused, and the deployed Git checkout remained clean. The external
verifier did not emit per-assertion checkpoints, so the evidence cannot
distinguish a transient public request failure from an operator-verifier
assertion failure.

Sequence 1 remains withdrawn and consumed. The monotonic release contract
forbids reselecting it. Recovery therefore requires a new clean Git SHA and a
strictly higher release sequence.

## Goals

- Make the root-owned publication command the authoritative public-verification
  gate rather than relying on an opaque external wrapper.
- Verify every member of the signed quartet through its production HTTPS URL.
- Verify the existing cache and security header contract and both existing
  health paths.
- Tolerate a short-lived DNS, TLS, proxy, or connection failure without hiding
  a persistent failure.
- Emit content-free diagnostics that identify the exact object, assertion,
  attempt, and observed status responsible for a failure.
- Preserve atomic selection, exact-SHA rollback, immutable release evidence,
  monotonic sequence enforcement, and the publication lock.
- Produce a reviewed sequence-2 release while keeping publication,
  installation, collection, and office activation as separate gates.

## Non-goals

- Reconstructing or guessing the unavailable sequence-1 verifier assertion.
- Reselecting, modifying, deleting, or repackaging the sequence-1 release.
- Changing Caddy routes, DNS, the Node service, database data, scoring, provider
  adapters, or companion collection behavior.
- Adding an artifact preview namespace or another public endpoint.
- Automatically publishing, installing, updating, or enabling a companion.
- Changing the companion's user-facing version solely because a release
  sequence was consumed.

## Chosen approach

`scripts/pi/runtime-raiders-artifacts.sh publish` remains responsible for local
source validation, immutable staging, atomic selection, public verification,
and selector rollback. Its existing `verify_selected_public_release` phase is
expanded instead of adding a second authoritative operator script.

The alternatives are rejected for this recovery:

1. An external verifier alone repeats the sequence-1 observability gap and can
   disagree with the publisher about when publication succeeded.
2. A public preview namespace could test bytes before changing `current`, but it
   would add new Caddy surface area, configuration, protocol rules, and security
   review for a problem that bounded post-selection verification can solve.

The independent operator check remains useful as a secondary acceptance check,
but it cannot convert a publisher failure into success and it must use the same
recorded quartet identity.

## Public verification contract

After the new selector is atomically installed, the publisher verifies these
exact public objects:

| Object | HTTPS path | Maximum bytes | Expected digest |
| --- | --- | ---: | --- |
| Installer | `/install.sh` | 8 MiB shared artifact contract | `INSTALLER_SHA256` |
| Companion ZIP | `/downloads/runtime-raiders-agent.zip` | 128 MiB | `ZIP_SHA256` |
| ZIP checksum | `/downloads/runtime-raiders-agent.zip.sha256` | 4 KiB | `CHECKSUM_SHA256` |
| Update manifest | `/downloads/runtime-raiders-agent.update.json` | 64 KiB | `UPDATE_MANIFEST_SHA256` |

Each request must use the fixed `https://raiders.redlattice.com` origin, disable
user curl configuration, reject redirects, require HTTPS, enforce its response
size limit, and write into the existing root-only verification directory. A
successful object check requires:

- HTTP success;
- the exact approved SHA-256;
- `Cache-Control: no-store`; and
- `X-Content-Type-Options: nosniff`.

Header names are matched case-insensitively and values are parsed as header
fields rather than by a loose substring search. Response bodies and headers are
never copied into diagnostic output. The fetched update manifest is also passed
through the existing canonical manifest validator so its sequence, release SHA,
version, protocol, ZIP URL, and ZIP digest must agree with the publication
arguments.

The publisher also requires HTTP success from
`https://raiders.redlattice.com/health` and
`http://127.0.0.1:8080/health`. Health response bodies are discarded and never
logged. Health verification does not modify or restart either service.

## Retry and diagnostic behavior

Every public GET receives at most five attempts. Each attempt has a three-second
connection timeout and a 15-second total timeout. Failed availability attempts
wait one second before the next attempt. Redirects remain disabled. The local
Node health check receives one five-second attempt because selector changes do
not affect the loopback service. There is no unbounded curl retry, sleep, or
network operation. Local validation failures are not retried.

The publisher writes content-free checkpoints to standard error for every
public attempt and assertion result. Standard output remains reserved for the
existing stable status fields. A failure identifies only bounded release facts
such as:

- artifact label or health label;
- attempt number and maximum attempts;
- assertion category such as `request`, `status`, `size`, `digest`, `header`,
  or `manifest`; and
- HTTP status or expected and observed digest when that category needs it.

Diagnostics may include fixed public URLs, release SHA, sequence, public
digests, and timestamps. They must not include response bodies, source or
temporary paths, provider records, prompts, responses, native identifiers,
tokens, credentials, environment values, or copied header blocks. A successful
publication still emits the existing stable status fields after verification.

Digest, header, size, and manifest failures are deterministic and fail
immediately for that object. Only transport or HTTP availability failures use
the remaining bounded attempts. This avoids repeatedly downloading a known-wrong
ZIP while still absorbing a brief route-propagation or network interruption.

## Failure and rollback behavior

The existing publication transaction remains authoritative:

1. Validate every supplied field and all stored releases.
2. Stage and revalidate the exact quartet locally.
3. Atomically create the immutable release directory.
4. Atomically select the new release.
5. Run the complete public verification contract.
6. Commit the selection only after every assertion passes.

Any verification failure returns nonzero and invokes the existing selector
rollback. If no release was selected before the attempt, `current` becomes
absent; otherwise the exact previously captured selector is restored. Rollback
continues to use identity and target checks so it refuses to overwrite an
out-of-band selector change.

The failed immutable release remains on disk for evidence. Once a v2 release
directory is created, its sequence is consumed even when public verification
rolls the selector back. A failed sequence-2 publication would therefore require
a new clean SHA and sequence 3; it would never justify reselecting sequence 2.
Failure does not reload Caddy, restart Node, alter the database, delete source
artifacts, or change companion collection state.

## Test strategy

The existing fake-command publication fixture will gain deterministic response
and attempt controls. Tests must prove:

- all four public objects, their exact digests, both required headers, the
  canonical update manifest, and both health paths are checked before success;
- a transient transport or HTTP failure succeeds only when a later allowed
  attempt passes;
- the attempt count and delay are bounded;
- exhausted request failures identify the object, attempt, and category;
- installer, ZIP, checksum, and update-manifest digest failures each fail
  closed without unnecessary further downloads;
- missing or invalid `no-store` and `nosniff` headers fail closed;
- public and local health failures fail closed;
- verification failure restores the prior selector, or removes the new
  selector when there was no prior release;
- the failed immutable release remains preserved and cannot be reused;
- cleanup leaves no verification, staging, or selector temporary paths;
- diagnostics remain content-free; and
- the existing publication, status, withdrawal, race, signal, ownership, mode,
  manifest, sequence, and rollback tests remain passing.

The focused artifact-publication test file, repository typecheck/build checks,
and the complete test suite must pass before a release commit is reviewed.

## Sequence-2 recovery release

Implementation changes are limited to the publisher, its tests, the operations
guide, and the tracked release identity required for the recovery. The new
clean commit uses:

```text
companion_version=0.2.0
release_sequence=2
update_protocol_version=1
```

Keeping version `0.2.0` is intentional: the companion behavior exposed to a
player is unchanged, while the monotonic sequence accurately records a new
signed release identity. The build must use the exact reviewed clean SHA and
must produce a newly recorded signed and notarized quartet. No digest from
sequence 1 is assumed or reused.

The sequence-1 operator evidence and immutable release stay preserved. A new
restricted sequence-2 operator record contains the clean release SHA, sequence,
version, protocol, four exact digests, signing/notarization evidence, test and
review results, and later publication observations.

## Gates and acceptance

1. Implement and test the publisher hardening on a clean branch or worktree.
2. Review the complete change and create the clean sequence-2 release commit.
3. Build, sign, notarize, staple, validate, and record the exact quartet.
4. Confirm production remains healthy, paused, unpublished, and on the approved
   server SHA before requesting publication.
5. Request a separate approval naming the exact sequence-2 release SHA,
   protocol, version, sequence, and all four digests.
6. Publish only that quartet and require the hardened publisher plus independent
   acceptance check to pass.
7. Request separate approval before installing the initial persistently-off
   canary. Collection remains off.

Because sequence 1 was never installed as the updater-capable canary, sequence
2 becomes the initial installed-off canary. The manual `raiders update` proof
moves to a separately built, reviewed, authorized, and published sequence 3.
Neither this design nor sequence-2 publication authorizes installation,
collection, a live provider canary, office activation, or scoring.
