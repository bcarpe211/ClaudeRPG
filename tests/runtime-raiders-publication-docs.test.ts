import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCompanionInstallCommand } from '../src/web/companion-install';

const readDoc = (path: string): string => readFileSync(resolve(path), 'utf8');

const runbook = readDoc('docs/RUNTIME_RAIDERS_CUTOVER.md');
const checklist = readDoc('docs/runtime-raiders/canary-checklist.md');
const operations = readDoc('docs/runtime-raiders/companion-operations.md');
const packet = readDoc('docs/runtime-raiders/cutover-authorization-packet.md');
const updateCanary = readDoc('docs/runtime-raiders/companion-update-canary.md');
const backlog = readDoc('docs/BACKLOG.md');
const piSetup = readDoc('docs/PI_SETUP.md');

const artifactRoot = '/var/lib/runtime-raiders';
const artifactUrls = [
  'https://raiders.redlattice.com/install.sh',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256',
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json',
];

function canonicalInstallCommandFromOperations(): string {
  const match = operations.match(
    /<!-- runtime-raiders-canonical-install-command:start -->\s*```sh\s*([^\n]+)\s*```\s*<!-- runtime-raiders-canonical-install-command:end -->/,
  );
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function secondaryHeaderStatus(
  headerLines: string[],
  name = 'Cache-Control',
  value = 'no-store',
): number {
  const publication = runbook.slice(
    runbook.indexOf('### 5.3 Publish the exact signed quartet'),
    runbook.indexOf('### 5.4 Install one verified-off canary'),
  );
  const functionStart = publication.indexOf('header_has_exact_value() {');
  const functionEnd = publication.indexOf('\ndownload_exact_https() {', functionStart);
  if (functionStart < 0 || functionEnd < 0) return 127;
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-runbook-headers-'));
  const headers = join(root, 'headers');
  try {
    writeFileSync(headers, headerLines.join('\r\n') + '\r\n');
    const result = spawnSync('bash', [
      '-c',
      [
        'set -eu',
        publication.slice(functionStart, functionEnd),
        'header_has_exact_value "$1" "$2" "$3"',
      ].join('\n'),
      'runtime-raiders-runbook-header-check',
      headers,
      name,
      value,
    ], { encoding: 'utf8' });
    return result.status ?? 127;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Runtime Raiders artifact-publication documentation', () => {
  it('keeps the marked office-onboarding command byte-identical to the website generator', () => {
    const documentedCommand = canonicalInstallCommandFromOperations();

    expect(documentedCommand).toBe(buildCompanionInstallCommand());
    expect(documentedCommand).not.toMatch(/(?:^|[ ;])status=/);
  });

  it('keeps the directly pasted publication downloader portable to zsh', () => {
    const publication = runbook.slice(
      runbook.indexOf('### 5.3 Publish the exact signed quartet'),
      runbook.indexOf('### 5.4 Install one verified-off canary'),
    );
    const downloader = publication.slice(
      publication.indexOf('download_exact_https() {'),
      publication.indexOf('\ndownload_exact_https 8388608'),
    );

    expect(downloader).toContain('download_http_code="$(curl');
    expect(downloader).toContain('test "$download_http_code" = 200');
    expect(downloader).not.toMatch(/(?:^|[ ;])status=/);
  });

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
      expect(document).toContain('--update-protocol-version "$UPDATE_PROTOCOL_VERSION"');
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
      '### G. Sequence-3 build, review, and signing',
      '### H. Sequence-3 publication',
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
      'Sequence-2 quartet published, 4/4 digests verified',
      'Installed sequence-2 artifact, daemon live and persistently off',
      'Sequence-3 quartet published, 4/4 digests verified',
      'Manual sequence-3 update proof',
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

  it('keeps every active operator surface on the recovery lifecycle', () => {
    for (const document of [runbook, piSetup, checklist, packet, updateCanary]) {
      expect(document).toContain('Sequence 1 is withdrawn and consumed');
      expect(document).toContain('companion-operations.md');
      for (const staleAuthority of [
        /sequence-1 publication/i,
        /installed-off sequence-1/i,
        /installed sequence-1/i,
        /manual sequence-2 update proof/i,
        /build\/sign\/notarize\/staple sequence 1/i,
        /install sequence 1/i,
      ]) expect(document).not.toMatch(staleAuthority);
    }
  });

  it('locks the exact publisher verification and secondary-withdrawal contract', () => {
    const quartet = [
      ['`/install.sh`', '8 MiB'],
      ['`/downloads/runtime-raiders-agent.zip`', '128 MiB'],
      ['`/downloads/runtime-raiders-agent.zip.sha256`', '4 KiB'],
      ['`/downloads/runtime-raiders-agent.update.json`', '64 KiB'],
    ];
    for (const [object, bound] of quartet) {
      expect(operations).toContain(`${object}, at most ${bound}`);
    }
    expect(operations).toContain('separately approved SHA-256');
    expect(operations).toContain('HTTP `200`');
    expect(operations).toContain('exact `Cache-Control: no-store`');
    expect(operations).toContain('`X-Content-Type-Options: nosniff`');
    expect(operations).toContain('canonical manifest validator');
    expect(operations).toContain('https://raiders.redlattice.com/health');
    expect(operations).toContain('http://127.0.0.1:8080/health');
    expect(operations).toContain('at most five attempts');
    expect(operations).toMatch(/three-second\s+connect timeout/);
    expect(operations).toContain('15-second total timeout');
    expect(operations).toMatch(/one second\s+between\s+failures/);
    expect(operations).toMatch(/only transport failures and non-`200` status are retried/i);
    expect(operations).toMatch(/Size,\s*digest, header, and canonical-manifest failures after HTTP `200` fail\s+immediately\./);
    expect(operations).toContain('Local health has one five-second attempt');
    expect(operations).toMatch(/content-free stderr\s+checkpoints[\s\S]*stable\s+publication status remains on stdout/i);
    expect(operations).toMatch(/verification failure automatically restores the prior selector[\s\S]*removes the new first selector/i);
    expect(operations).toMatch(/secondary acceptance[\s\S]*cannot override publisher failure/i);
    expect(operations).toMatch(/withdraw only if\s+status still selects the exact approved `\$RELEASE_SHA`[\s\S]*never withdraw an\s+unknown selection/i);
  });

  it('keeps active publication recovery subordinate to automatic rollback and exact selection', () => {
    for (const document of [runbook, packet]) {
      expect(document).toMatch(/publisher[^.]*automatically restores the prior selector[^.]*removes[^.]*first\s+selector/i);
      expect(document).toMatch(/secondary acceptance fails[\s\S]*inspect status[\s\S]*withdraw only[\s\S]*exact approved `\$RELEASE_SHA`/i);
      expect(document).toMatch(/never withdraw an\s+unknown\s+selection/i);
    }
  });

  it('uses the canonical employee command for routine install and the safe downloader for verified canary installation', () => {
    for (const document of [runbook, operations]) {
      expect(document).not.toMatch(/--code(?:\s|=)/);
      expect(document).toContain('--code-file "$CANARY_CODE_FILE"');
      expect(document).toContain('umask 077');
    }
    expect(operations).toMatch(/routine office installation[\s\S]*one-line/i);
    const routine = operations.slice(operations.indexOf('## Routine office installation'));
    expect(routine).toContain(buildCompanionInstallCommand());
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
    expect(publication).toContain('--suppress-connect-headers');
    expect(publication).toContain('--connect-timeout 10');
    expect(publication).toContain('--max-time 120');
    for (const bound of ['8388608', '134217728', '4096']) {
      expect(publication).toContain(`download_exact_https ${bound}`);
    }
  });

  it.each([
    ['earlier exact and final missing', [
      'HTTP/1.1 200 Connection established',
      'Cache-Control: no-store',
      '',
      'HTTP/2 200',
      'X-Content-Type-Options: nosniff',
      '',
    ], false],
    ['earlier exact and final conflicting', [
      'HTTP/1.1 200 Connection established',
      'Cache-Control: no-store',
      '',
      'HTTP/2 200',
      'Cache-Control: private',
      '',
    ], false],
    ['earlier conflicting and final exact', [
      'HTTP/1.1 200 Connection established',
      'Cache-Control: private',
      '',
      'HTTP/2 200',
      'Cache-Control: no-store',
      '',
    ], true],
    ['duplicate exact final field', [
      'HTTP/2 200',
      'Cache-Control: no-store',
      'Cache-Control: no-store',
      '',
    ], false],
    ['conflicting duplicate final field', [
      'HTTP/2 200',
      'Cache-Control: no-store',
      'Cache-Control: private',
      '',
    ], false],
    ['later trailer cannot supply final field', [
      'HTTP/2 200',
      'X-Content-Type-Options: nosniff',
      '',
      'Cache-Control: no-store',
    ], false],
    ['value comparison remains case-sensitive', [
      'HTTP/2 200',
      'Cache-Control: No-Store',
      '',
    ], false],
    ['malformed final field name fails closed', [
      'HTTP/1.1 200 Connection established',
      'Cache-Control: no-store',
      '',
      'HTTP/2 200',
      'Cache-Control : no-store',
      '',
    ], false],
  ])('binds secondary required headers to the final response block: %s', (
    _name,
    headerLines,
    shouldPass,
  ) => {
    expect(secondaryHeaderStatus(headerLines as string[]) === 0).toBe(shouldPass);
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
    const publication = piSetup.indexOf('sequence-2 publication');
    const installedOff = piSetup.indexOf('installed-off sequence-2');
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

  it('keeps the recovery two-sequence live provider proof and privacy record pending', () => {
    for (const step of [
      '1. preserve withdrawn sequence 1 as immutable evidence',
      '2. build/sign/notarize/staple sequence 2 from its exact clean SHA',
      '3. separately approve Caddy route preparation and sequence-2 publication',
      '4. install sequence 2 with collection persistently off',
      '5. commit `companion/RELEASE` version `0.2.1`, sequence `3`',
      '6. rebuild/review/sign and separately approve sequence-3 publication',
      '7. observe one notification and matching `raiders status` availability',
      '8. run `raiders update` manually',
      '9. confirm no second notification for sequence 3',
      '10. separately authorize a bounded `raiders on` canary',
      '11. complete one official Codex Desktop root Run and one Codex CLI root Run',
      '12. verify `codex_desktop` and `codex_cli`',
      '13. run `raiders off` before seeking separate office activation',
    ]) expect(updateCanary).toContain(step);
    expect(updateCanary).toContain('aggregate status/timestamps only');
    expect(updateCanary).toMatch(/never record prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments/i);
    expect(updateCanary).toMatch(/pending/i);
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
      'Caddy preparation', 'sequence-2 publication', 'installed-off',
      'sequence-3 build', 'sequence-3 publication', 'notification',
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
    expect(updateCanary).toContain('RELEASE_SHA="$(git rev-parse HEAD)"');
    expect(updateCanary).toContain('RELEASE_OUTPUT="dist/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"');
    expect(updateCanary).toContain('scripts/release/build-runtime-raiders-agent.sh \\\n');
    expect(updateCanary).toContain('--release-sha "$RELEASE_SHA" --output "$RELEASE_OUTPUT"');
    expect(updateCanary).not.toContain('dist/install.sh');
    expect(updateCanary).toContain('launchctl kickstart -k "gui/$(id -u)/com.redlattice.runtime-raiders-agent"');
    expect(updateCanary).toContain('24-hour due boundary');
    expect(updateCanary).toContain('raiders status');
    expect(updateCanary).toContain('raiders doctor');
    expect(updateCanary).toContain('Runtime Raiders Agent.rollback.app/Contents/MacOS/runtime-raiders-agent" __recover-update');
    expect(operations).toMatch(/withdrawn v2[^.]*new clean SHA[^.]*higher sequence/i);
    expect(operations).not.toMatch(/withdrawn v2[^.]*reselected/i);
    for (const field of ['release sequence', 'companion version', 'installer sha-256', 'zip sha-256', 'checksum-file sha-256', 'update-manifest sha-256']) {
      expect(packet.toLowerCase()).toContain(field);
    }
    expect(packet).toContain('### G. Sequence-3 build, review, and signing');
    expect(packet).toContain('### H. Sequence-3 publication');
  });

  it('derives the off-state notification due boundary from validated owner-only update state', () => {
    const stateLine = updateCanary.indexOf('UPDATE_STATE="$HOME/Library/Application Support/Runtime Raiders/state/update-state.json"');
    const block = updateCanary.slice(
      updateCanary.lastIndexOf('(\n  set -eu', stateLine),
      updateCanary.indexOf('## Manual update proof and recovery'),
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
