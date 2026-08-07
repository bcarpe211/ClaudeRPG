import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readDoc = (path: string): string => readFileSync(resolve(path), 'utf8');

const runbook = readDoc('docs/RUNTIME_RAIDERS_CUTOVER.md');
const checklist = readDoc('docs/runtime-raiders/canary-checklist.md');
const operations = readDoc('docs/runtime-raiders/companion-operations.md');
const packet = readDoc('docs/runtime-raiders/cutover-authorization-packet.md');
const backlog = readDoc('docs/BACKLOG.md');
const piSetup = readDoc('docs/PI_SETUP.md');

const artifactRoot = '/var/lib/runtime-raiders';
const artifactUrls = [
  'https://raiders.redlattice.com/install.sh',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json',
];

describe('Runtime Raiders artifact-publication documentation', () => {
  it('binds every operational document to the fixed artifact root', () => {
    for (const document of [runbook, checklist, operations, packet]) {
      expect(document).toContain(artifactRoot);
    }
  });

  it('documents status, four-digest publication, and exact-SHA withdrawal', () => {
    for (const document of [runbook, operations]) {
      expect(document).toContain('runtime-raiders-artifacts.sh status');
      expect(document).toContain('runtime-raiders-artifacts.sh publish');
      expect(document).toContain('--release-sequence "$RELEASE_SEQUENCE"');
      expect(document).toContain('--companion-version "$COMPANION_VERSION"');
      expect(document).toContain('--installer-sha256 "$INSTALLER_SHA256"');
      expect(document).toContain('--zip-sha256 "$ZIP_SHA256"');
      expect(document).toContain('--checksum-sha256 "$CHECKSUM_SHA256"');
      expect(document).toContain('--update-manifest-sha256 "$UPDATE_MANIFEST_SHA256"');
      expect(document).toContain('runtime-raiders-artifacts.sh withdraw');
      expect(document).toContain('--release-sha "$RELEASE_SHA"');
    }
  });

  it('keeps every release approval as a separate ordered gate', () => {
    const approvalHeadings = [
      '### A. Updater hold',
      '### B. Exact release publication',
      '### C. Fail-closed Caddy preparation',
      '### D. Production cutover',
      '### E. Signed companion publication',
      '### F. Installed-off canary',
      '### G. Sequence-2 build, review, and signing',
      '### H. Sequence-2 publication',
      '### I. Manual update proof',
      '### J. Bounded live provider canary',
      '### K. Office activation',
    ];
    let previous = -1;
    for (const heading of approvalHeadings) {
      const index = packet.indexOf(heading);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('keeps Caddy preparation empty, unpublished, and fail-closed', () => {
    const caddyApproval = packet.slice(
      packet.indexOf('### C. Fail-closed Caddy preparation'),
      packet.indexOf('### D. Production cutover'),
    );

    expect(caddyApproval).toContain('current');
    expect(caddyApproval).toMatch(/absent/i);
    expect(caddyApproval).toMatch(/all four artifact URLs[^.]*404/i);
    expect(caddyApproval).toMatch(/does not authorize artifact publication/i);
    for (const url of artifactUrls) expect(packet).toContain(url);
  });

  it('records every post-cutover gate and the verified-local first installer', () => {
    for (const row of [
      'Caddy release store prepared, selector absent',
      'Artifact routes unpublished, 4/4 return 404',
      'Signed quartet published, 4/4 digests verified',
      'Installed sequence-1 artifact, daemon live and persistently off',
      'Sequence-2 quartet published, 4/4 digests verified',
      'Manual sequence-2 update proof',
    ]) {
      expect(checklist).toContain(row);
    }
    expect(operations).toMatch(/locally downloaded[^.]*installer/i);
    expect(operations).toMatch(/verify[^.]*SHA-256[^.]*before execution/i);
  });

  it('documents sequence-2 publication recovery and defers manual update proof to sequence 3', () => {
    expect(operations).toContain('Sequence 1 is withdrawn and consumed');
    expect(operations).toContain('release_sequence=2');
    expect(operations).toContain('## Install the sequence-2 canary locally and persistently off');
    expect(operations).toMatch(/publisher[\s\S]*all four[\s\S]*bounded retries/i);
    expect(operations).toMatch(/verification failure[\s\S]*restores[\s\S]*selector/i);
    expect(operations).toMatch(/sequence 2 becomes the initial installed-off canary/i);
    expect(operations).toMatch(/manual `raiders update` proof[\s\S]*sequence 3/i);
  });

  it('keeps the routine pipe distinct from the verified local canary installer', () => {
    for (const document of [runbook, operations]) {
      expect(document).not.toMatch(/--code(?:\s|=)/);
      expect(document).toContain('--code-file "$CANARY_CODE_FILE"');
      expect(document).toContain('umask 077');
    }
    expect(operations).toMatch(/routine office installation[\s\S]*one-line/i);
    const routine = operations.slice(operations.indexOf('## Routine office installation'));
    expect(routine).toContain('curl --fail --silent --show-error https://raiders.redlattice.com/install.sh | /bin/sh');
    const installedOff = operations.slice(
      operations.indexOf('## Install the sequence-2 canary'),
      operations.indexOf('## Routine office installation'),
    );
    expect(installedOff).toContain('--output "$CANARY_INSTALLER"');
    expect(installedOff).toContain('test "$(shasum -a 256 "$CANARY_INSTALLER"');
    expect(installedOff).not.toMatch(/\|\s*(?:sh|\/bin\/sh)/);
    expect(installedOff).not.toMatch(/update\.json[^\n]*\|/);
    expect(installedOff).not.toMatch(/runtime-raiders-agent\.zip[^\n]*\|/);
  });

  it('uses bounded no-redirect HTTPS for publication downloads', () => {
    const publication = runbook.slice(
      runbook.indexOf('### 5.3 Publish the exact signed quartet'),
      runbook.indexOf('### 5.4 Install one verified-off canary'),
    );

    expect(publication).toContain('download_exact_https()');
    expect(publication).toContain("--proto '=https'");
    expect(publication).toContain("--proto-redir '=https'");
    expect(publication).toContain('--max-redirs 0');
    expect(publication).toContain('--connect-timeout 10');
    expect(publication).toContain('--max-time 120');
    for (const bound of ['1048576', '134217728', '4096']) {
      expect(publication).toContain(`download_exact_https ${bound}`);
    }
  });

  it('makes Caddy preparation one transactional block with rollback armed before replacement', () => {
    const section = runbook.slice(
      runbook.indexOf('### 2.3 Prepare the fail-closed Caddy routes'),
      runbook.indexOf('### 2.4 Run the final read-only preflight'),
    );
    const rollback = section.slice(
      section.indexOf('restore_prior_caddy()'),
      section.indexOf("trap 'restore_prior_caddy $?' EXIT"),
    );
    const trap = section.indexOf("trap 'restore_prior_caddy $?' EXIT");
    const replacement = section.indexOf('"$REVIEWED_CADDY" "$CADDY_CONFIG"');
    const clear = section.lastIndexOf('trap - EXIT HUP INT TERM');
    const lastArtifact = section.lastIndexOf('runtime-raiders-agent.zip.sha256');

    expect(rollback).toContain('"$CADDY_BACKUP_SHA256"');
    expect(rollback).toContain('"$CADDY_BACKUP" "$CADDY_CONFIG"');
    expect(rollback).toContain('--envfile "$CADDY_ENV"');
    expect(rollback).toContain('systemctl reload caddy.service');
    expect(rollback).toContain('https://raiders.redlattice.com/health');
    expect(rollback).toContain('https://clauderpg.redlattice.com/health');
    expect(rollback).toContain('exit "$original_status"');
    expect(trap).toBeGreaterThan(-1);
    expect(replacement).toBeGreaterThan(trap);
    expect(clear).toBeGreaterThan(lastArtifact);
    expect(section).not.toMatch(/If validation, reload, health/);
  });

  it('keeps Pi setup onboarding behind publication and both canary approvals', () => {
    const publication = piSetup.indexOf('sequence-1 publication');
    const installedOff = piSetup.indexOf('installed-off sequence-1');
    const liveCanary = piSetup.indexOf('bounded `raiders on`');
    const officeApproval = piSetup.indexOf('office activation approval');
    const onboarding = piSetup.indexOf('Each teammate registers');

    expect(publication).toBeGreaterThan(-1);
    expect(installedOff).toBeGreaterThan(publication);
    expect(liveCanary).toBeGreaterThan(installedOff);
    expect(officeApproval).toBeGreaterThan(liveCanary);
    expect(onboarding).toBeGreaterThan(officeApproval);
  });

  it('documents manual updates as the only installed-player update path', () => {
    for (const document of [runbook, checklist, operations, packet]) {
      expect(document).toContain('raiders update');
      expect(document).toContain('runtime-raiders-agent.update.json');
    }
    expect(operations).toMatch(/already-installed[\s\S]*only `raiders update`/i);
    expect(operations).toMatch(/anonymous static GET[\s\S]*collection is off/i);
  });

  it('keeps the two-sequence live provider proof and privacy record pending', () => {
    const canary = readDoc('docs/runtime-raiders/companion-update-canary.md');
    for (const step of [
      '1. build/sign/notarize/staple sequence 1',
      '2. separately approve Caddy route preparation and sequence-1 publication',
      '3. install sequence 1 with collection persistently off',
      '4. commit `companion/RELEASE` version `0.2.1`, sequence `2`',
      '5. rebuild/review/sign and separately approve sequence-2 publication',
      '6. observe one notification and matching `raiders status` availability',
      '7. run `raiders update` manually',
      '8. confirm no second notification for sequence 2',
      '9. separately authorize a bounded `raiders on` canary',
      '10. complete one official Codex Desktop root Run and one Codex CLI root Run',
      '11. verify `codex_desktop` and `codex_cli`',
      '12. run `raiders off` before seeking separate office activation',
    ]) expect(canary).toContain(step);
    expect(canary).toContain('aggregate status/timestamps only');
    expect(canary).toMatch(/never record prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments/i);
    expect(canary).toMatch(/pending/i);
  });

  it('makes publication, withdrawal, and canary snippets fail fast in isolated subshells', () => {
    const section = runbook.slice(
      runbook.indexOf('### 5.3 Publish the exact signed quartet'),
      runbook.indexOf('## 6. Canary activation'),
    );
    for (const marker of [
      'runtime-raiders-artifacts.sh publish',
      'download_exact_https()',
      'runtime-raiders-artifacts.sh withdraw',
      'CANARY_INSTALLER="$(mktemp)"',
    ]) {
      const before = section.slice(0, section.indexOf(marker));
      expect(before.lastIndexOf('(\n  set -eu')).toBeGreaterThan(-1);
    }
    const canary = section.slice(section.indexOf('CANARY_INSTALLER'), section.indexOf('## 6. Canary activation'));
    expect(canary.indexOf('test "$(shasum -a 256')).toBeLessThan(canary.indexOf('sh "$CANARY_INSTALLER"'));
    expect(canary).toContain('trap cleanup_canary_files EXIT');
  });

  it('requires the complete off-to-office lifecycle in the primary runbook and Pi onboarding', () => {
    const required = [
      'Caddy preparation', 'sequence-1 publication', 'installed-off',
      'sequence-2 build', 'sequence-2 publication', 'notification',
      'raiders update', 'raiders on', 'Codex Desktop', 'Codex CLI',
      'raiders off', 'office activation',
    ];
    for (const document of [runbook, piSetup]) {
      let last = -1;
      for (const term of required) {
        const next = document.toLowerCase().indexOf(term.toLowerCase(), last + 1);
        expect(next, term).toBeGreaterThan(last);
        last = next;
      }
    }
    expect(piSetup.indexOf('Each teammate registers')).toBeGreaterThan(
      piSetup.indexOf('10. separate office activation approval'),
    );
    expect(runbook).not.toMatch(/If every canary[^.]*office activation approval[\s\S]*Have participating users run `raiders on`/);
  });

  it('documents build, cadence, no-reselection, approval fields, and update recovery evidence', () => {
    const canary = readDoc('docs/runtime-raiders/companion-update-canary.md');
    expect(canary).toContain('RELEASE_SHA="$(git rev-parse HEAD)"');
    expect(canary).toContain('scripts/release/build-runtime-raiders-agent.sh --release-sha "$RELEASE_SHA"');
    expect(canary).toContain('launchctl kickstart -k "gui/$(id -u)/com.redlattice.runtime-raiders-agent"');
    expect(canary).toContain('24-hour due boundary');
    expect(canary).toContain('raiders status');
    expect(canary).toContain('raiders doctor');
    expect(canary).toContain('Runtime Raiders Agent.rollback.app/Contents/MacOS/runtime-raiders-agent" __recover-update');
    expect(operations).toMatch(/withdrawn v2[^.]*new clean SHA[^.]*higher sequence/i);
    expect(operations).not.toMatch(/withdrawn v2[^.]*reselected/i);
    for (const field of ['release sequence', 'companion version', 'installer sha-256', 'zip sha-256', 'checksum-file sha-256', 'update-manifest sha-256']) {
      expect(packet.toLowerCase()).toContain(field);
    }
    expect(packet).toContain('### G. Sequence-2 build, review, and signing');
    expect(packet).toContain('### H. Sequence-2 publication');
  });

  it('derives the off-state notification due boundary from validated owner-only update state', () => {
    const canary = readDoc('docs/runtime-raiders/companion-update-canary.md');
    const stateLine = canary.indexOf('UPDATE_STATE="$HOME/Library/Application Support/Runtime Raiders/state/update-state.json"');
    const block = canary.slice(
      canary.lastIndexOf('(\n  set -eu', stateLine),
      canary.indexOf('## Manual update proof and recovery'),
    );
    const orderedContract = [
      'set -eu',
      'UPDATE_STATE="$HOME/Library/Application Support/Runtime Raiders/state/update-state.json"',
      'test -f "$UPDATE_STATE"',
      'test ! -L "$UPDATE_STATE"',
      'test "$(stat -f \'%u:%Lp\' "$UPDATE_STATE")" = "$(id -u):600"',
      'LAST_ATTEMPT_MS="$(plutil -extract lastCheckAttemptMS raw -o - "$UPDATE_STATE")"',
      'case "$LAST_ATTEMPT_MS" in \'\'|*[!0-9]*) exit 1 ;; esac',
      'test "${#LAST_ATTEMPT_MS}" -le 16',
      'test "$LAST_ATTEMPT_MS" -le 9007199168340991',
      'DUE_MS=$((LAST_ATTEMPT_MS + 86400000))',
      'NOW_MS=$(( $(date +%s) * 1000 ))',
      "printf 'Runtime Raiders update check due UTC: '",
      "date -u -r $((DUE_MS / 1000)) '+%Y-%m-%dT%H:%M:%SZ'",
      'test "$NOW_MS" -ge "$DUE_MS"',
      "printf '%s\\n' 'Runtime Raiders update check is not due; refusing restart.' >&2",
      'exit 1\n  }',
      'launchctl kickstart -k "gui/$(id -u)/com.redlattice.runtime-raiders-agent"',
      'raiders status',
      'raiders doctor',
    ];
    const assertOrdered = (text: string): void => {
      let previous = -1;
      for (const statement of orderedContract) {
        const next = text.indexOf(statement, previous + 1);
        expect(next, statement).toBeGreaterThan(previous);
        previous = next;
      }
    };
    assertOrdered(block);

    const statusDoctorDrift = block.replace(
      'raiders status\n  raiders doctor',
      'raiders doctor\n  raiders status',
    );
    expect(() => assertOrdered(statusDoctorDrift)).toThrow();
    expect(() => assertOrdered(block.replace('test ! -L "$UPDATE_STATE"\n', ''))).toThrow();
    expect(() => assertOrdered(block.replace('exit 1\n  }\n  launchctl kickstart', '}\n  launchctl kickstart'))).toThrow();
  });

  it('does not present unapproved 2026-08-04 work as verified evidence', () => {
    for (const document of [runbook, checklist, operations, packet]) {
      expect(document).not.toContain('2026-08-04');
    }
  });

  it('defers the branded 404 without making it a release dependency', () => {
    expect(backlog).toMatch(/^- \[ \] Branded Runtime Raiders 404 page\b/m);
    expect(backlog).toMatch(/Branded Runtime Raiders 404 page[\s\S]*not an asset dependency for this release/i);
  });
});
