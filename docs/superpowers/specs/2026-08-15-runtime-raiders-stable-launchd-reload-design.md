# Runtime Raiders stable launchd reload design

Status: approved for next-release implementation on 2026-08-15. This design
does not authorize rebuilding or changing sequence 12, signing, notarization,
publication, Pi changes, companion installation, collection, canary activation,
or office activation.

## Release boundary

The accepted sequence-12 source and artifacts at
`188b8936bbaa6fb60f1787e0cffe380b8bb35253` remain immutable. This repair is
implemented only on the isolated
`codex/fix-migrator-stable-launchd-reload` branch for a later release.

## Confirmed defect

The one-time sequence-8 migrator bootstraps a prepared launchd job whose
`ProgramArguments` point directly to the candidate agent with
`__runtime-raiders-installer-migration-generation 1`. After durable commit, it
writes the stable plist containing the signed launcher and literal `daemon`,
but it does not reload the registered launchd job. It resumes the already
running prepared process and then removes its transaction record, so the
migration appears healthy while launchd retains the temporary registration.

The defect was reproduced on the installed canary. The plist on disk selected
the stable launcher, while `launchctl print` selected sequence 10 directly with
the migration-only arguments. A later `raiders update` used `kickstart -k`,
which correctly restarted the registered job but could not change that stale
registration. Without the one-time migration lease, every restart failed
closed before opening the control socket. Sequence 12 could not start, and the
rollback could not restore a healthy sequence-10 daemon.

The installer test fake records only whether a job exists. It does not retain
the plist arguments captured at bootstrap, so its final assertions cannot
distinguish the temporary prepared registration from the stable launcher job.

## Approaches considered

### Reload the stable job at the migration commit boundary — selected

While the prepared lease is still held, unload the temporary migration job,
prove the label absent, bootstrap the newly written stable plist, and re-prove
the committed candidate's prepared health and protected-state identity before
resuming it. This makes the registered job match the durable plist before the
migration can be accepted.

This is the smallest solution because the existing
`committed-pending-resume` recovery path already performs the same stable-job
reload after interruption.

### Teach the updater to repair stale migration jobs — rejected

The public updater should operate only on a stable-launcher installation.
Adding migration-history detection and launchd replacement would broaden its
privileges and permanently carry a one-canary repair into every update.

### Keep the temporary registration until the next login — rejected

This leaves updates and manual restarts broken and makes correctness depend on
an unrelated logout or reboot. A successful migration must be restart-safe
immediately.

## Transaction flow

The migration success path remains prepared and fail-closed:

1. Bootstrap the migration-only prepared candidate under the held lease.
2. Verify prepared health and exact protected-state preservation.
3. Durably record `committed-pending-resume`.
4. Durably write generation-1 active release state.
5. Atomically install and synchronize the stable launcher plist.
6. Boot out the temporary registered job and prove the label absent.
7. Bootstrap the stable plist while the lease remains held.
8. Re-verify the same candidate identity, generation, disabled/enabled intent,
   zero active Runs, queued-event count, and protected-state bytes.
9. Resume the stable-launched candidate, verify resumed health, retire only the
   exact legacy command link, accept the journal, and release the lease.

No general path validation, ownership rule, symlink rule, app-mode rule, or
release identity check changes.

## Failure and recovery

The journal remains `committed-pending-resume` throughout the stable-job reload.
Any failure or process death after the commit therefore re-enters the existing
post-commit recovery path, which:

- reacquires the prepared lease;
- boots out any partial job registration;
- proves the label absent;
- rewrites and synchronizes the same committed release state and stable plist;
- bootstraps the stable job;
- verifies prepared health and protected state;
- resumes the candidate; and
- completes command retirement and acceptance.

The migration must not roll back to sequence 8 after the durable commit marker.
It must not accept while launchd retains migration-only arguments. Failure does
not enable collection, contact upload endpoints, delete diagnostic evidence, or
weaken the fail-closed startup lease.

## Test design

The launchctl fake will persist the effective `ProgramArguments` read from the
plist at every successful bootstrap. `print` continues to model job presence,
while a test-only loaded-job record makes the registered mode observable.

The first red test performs a successful real rendered sequence-8 migration
and requires all of the following at return:

- the loaded job record selects the stable launcher plus literal `daemon`;
- it contains no direct release executable and no migration-generation
  argument;
- launchctl observed a post-commit bootout and second bootstrap;
- the disk plist and loaded-job record agree; and
- collection intent, enrollment, collector state, queue count, and protected
  state remain unchanged.

Additional failure-injection coverage kills or fails the installer after the
stable plist write, during stable-job bootout/bootstrap, and after the stable
job reaches prepared health. Re-entry must converge only to the committed
candidate with a stable loaded job. Ambiguous bootout/bootstrap failures must
remain fail-closed and recoverable.

The focused migration matrix runs first, followed by the complete installer
suite and Runtime Raiders Gate 1. No test may use real launchd, network, Apple
trust services, the installed canary, or the Pi.

## Production files

- `companion/legacy-sequence8/migrate.sh`: reload and re-attest the stable job
  before resume.
- `tests/companion-installer.test.ts`: model registered launchd arguments and
  add success, failure, and interruption regression coverage.

No public updater, launcher, collector, server, Caddy, release metadata,
artifact, or general installer path-safety code changes are in scope.

## Acceptance

The repair is accepted only when the new loaded-job test fails against the
current migrator for the observed stale-registration reason, passes after the
minimal reload, and all focused and broader tests pass without repository or
scratch residue. The diff must remain limited to this design, the one-time
migrator, and its installer tests.
