# Runtime Raiders companion release gates

This runbook keeps failures on the cheapest, safest side of the release boundary. Passing a gate permits review of the next gate; it never grants that gate's authority automatically.

## Gate 1: isolated local lifecycle

Run from the repository root:

```sh
npm run canary:lifecycle-test
```

This is the routine development gate. It checks installer and release-builder shell syntax, then runs the complete Swift companion package and disposable release-gate suites in that exact fail-fast order. The gate owns a private temporary home, support/config/cache directories, Swift scratch tree, npm cache, and temporary directory. Swift automatic dependency resolution is disabled, npm is offline, and `npx --no-install` may use only the already installed local Vitest. Live network, SSH, and launchd command names resolve to deny-only boundaries. The suites retain local Unix-socket and FSEvents coverage while using synthetic content-free state and injected trust facts. The gate does not read provider records or use the installed companion. It does not sign, notarize, contact the Pi or Caddy, publish files, enable collection, or activate players.

Run it twice before advancing. The second clean pass proves that a previous workspace, journal, or old release is not required.

## Gate 2: real signed quartet while unpublished

Gate 2 requires separate approval for real Developer ID signing and local trust validation. Keep the signed quartet in a local owner-controlled directory and keep it unpublished. Then run:

```sh
RUNTIME_RAIDERS_CODESIGN_IDENTITY='Developer ID Application: …' \
  bash scripts/test/verify-runtime-raiders-signed-release.sh /absolute/path/to/quartet
```

The harness refuses URLs, symlinks, unsafe files, extra files, checksum or manifest mismatches, and anything other than the four expected local artifacts. It validates the archive and both application bundles with the production validator, `codesign`, Gatekeeper, required universal slices, and stapled notarization tickets. It independently rebuilds the universal validator from the reviewed local source, derives release facts from the signed bundle, uses the same deterministic renderer as the release builder, and requires `install.sh` to match that rendering byte-for-byte before any installer execution. Appended comments, dead code, command substitutions, or embedded-validator changes therefore fail closed.

Inside one owner-only temporary home it then:

- signs disposable older/current/newer agent fixtures with the separately approved identity while removing signing and notarization credentials from every installer, launcher, and daemon environment;
- runs the real signed launcher against active, fallback-bearing, held-trial, missing, malformed, unsafe-mode, symlink, and identity-mismatch states;
- runs the exact rendered installer with only network and launchd replaced by local fakes; and
- copies only the installed-off sequence-8 application bundle as read-only migration input, injects every migration failure checkpoint into a temporary installer copy, and compares no-follow pre/post fingerprints of the complete persistent support, legacy, rollback, diagnostic, failed-candidate, update-workspace, plist, profile, command, inode, and extended-attribute surfaces. Protocol-2 launcher, release, and installation residue must remain absent, and the restored daemon must pass the existing peer-attested exact-legacy-executable status route.

Every temporary daemon record binds a decimal PID greater than one to its expected temporary-root executable/command and captured process-start identity. Cleanup rejects corrupt or reused records before signaling, polls TERM for a fixed bound, then polls KILL for a fixed bound, and never uses PID zero, a process group, `kill -0`, or an unbounded wait. Open lease descriptors, FIFOs, children, and the verified owner-only temporary tree are cleaned on normal exit and signals. The harness never reads the canary's enrollment or state and never changes its installed bundle, job, shim, or collection setting. A Gate 2 pass does not authorize publication or installation.

## Gate 3: installed-off migration canary

Gate 3 requires separate approvals for artifact publication and for migration of the current sequence-8 canary. Collection must remain persistently off.

Before migration, record the exact enrollment and protected-state fingerprints. After migration, verify:

- launcher and agent signatures and identities;
- generation 1 with the new release active and `fallback` and `trial` null;
- the flat sequence-8 application remains unchanged as evidence;
- enrollment and protected local state are preserved;
- the daemon is healthy; and
- there are zero active Runs and zero unexpected queued events.

A Gate 3 pass does not authorize a normal update, `raiders on`, or another canary.

## Gate 4: normal protocol-2 update canary

Gate 4 requires separate approval to build and publish one subsequent reviewed release and another approval to run `raiders update` on the installed-off canary.

Verify the prepared trial, atomic commit, exact active and fallback identities, release-state generations, protected-state preservation, daemon health, zero active Runs, queued-event expectations, and preserved collection intent. The update must retain older releases and remain successful even if cleanup or journal residue is present.

## Later decisions

Collection remains off through all four release gates unless it receives its own explicit authorization. `raiders on` and office-wide activation are later, independent decisions. No test result, commit, merge, signature, notarization, publication, migration, or update implicitly authorizes either one.
