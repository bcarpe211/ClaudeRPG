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
      '### G. Sequence-2 build, review, and publication',
      '### H. Manual update proof',
      '### I. Bounded live provider canary',
      '### J. Office activation',
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
      operations.indexOf('## Install the sequence-1 canary'),
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
    const publication = piSetup.indexOf('signed companion publication');
    const installedOff = piSetup.indexOf('installed-off canary');
    const liveCanary = piSetup.indexOf('live canary activation');
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
