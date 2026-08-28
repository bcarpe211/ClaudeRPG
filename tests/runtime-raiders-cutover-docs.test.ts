import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function markdownFiles(path: string): string[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(relative);
    return entry.isFile() && entry.name.endsWith('.md') ? [relative] : [];
  });
}

const authorityPath = 'docs/runtime-raiders/README.md';
const authority = read(authorityPath);
const employee = read('docs/runtime-raiders/employee-beta.md');
const operations = read('docs/runtime-raiders/companion-operations.md');
const deployment = read('docs/runtime-raiders/server-deployment.md');
const receipt = read('docs/runtime-raiders/releases/0.4.9.md');
const activePaths = [
  'README.md',
  'docs/PI_SETUP.md',
  'docs/BACKLOG.md',
  ...markdownFiles('docs/runtime-raiders'),
];

describe('Runtime Raiders documentation authority contract', () => {
  it('maps every current operating surface from one resolvable active index', () => {
    expect(authority).toContain('Executable scripts and their tests are the behavioral truth');

    for (const target of [
      'employee-beta.md',
      'companion-operations.md',
      'server-deployment.md',
      'releases/0.4.9.md',
      'provider-record-evidence.md',
      'scoring-calibration-v1.md',
      '../archive/README.md',
    ]) {
      expect(authority).toContain(`](${target})`);
      expect(existsSync(resolve(root, dirname(authorityPath), target))).toBe(true);
    }
    expect(authority).toContain('active,\n  immutable generated evidence for policy reviewers; do not edit it by hand.');
  });

  it('records the immutable 0.4.9 receipt facts', () => {
    for (const fact of [
      'b8beccafbe5cd2e24c44ab84bd21feb08df856b7',
      '5787820693babee8ccfc32c601c88fe239dd1799de51035699a1b30d95235bba',
      '8bdd665e92b1dbdb8472b1632f0f7a427c9414082a39d6b8ff0d850b890ac047',
      '149 Node files and 2,224 tests',
      'Apple trust acceptance passed',
      'zero active Runs and zero queued events',
      'health and artifact-hash verification passed',
      'production remained paused',
      'no game restart and no data or history mutation',
    ]) expect(receipt.replace(/\s+/g, ' ')).toContain(fact);
  });

  it('keeps current lifecycle and server deployment safety clauses active', () => {
    for (const clause of [
      'Publishing a release never turns collection on for anyone.',
      'Change Raider: `raiders off`, then `raiders re-enroll`.',
      'Revoke and remove every local Runtime Raiders artifact: `raiders uninstall --everything`.',
      'Neither removal mode deletes a Raider, account, Run, score, reward, or beta history.',
      'Queued work is not part of a replacement request and cannot be relabeled for the target Raider.',
      'Scripts use `raiders status --json`; never parse the human-readable output.',
      'rluser@clauderpg.redlattice.com',
      'game_state.paused=1',
      'recoverable backup',
      'approved scoped pull and restart',
      'database integrity and retained counts',
      'Restore the exact recorded prior checkout',
      'Companion publication is a separate procedure and never enables collection.',
    ]) expect(`${employee}\n${operations}\n${deployment}`.replace(/\s+/g, ' ')).toContain(clause);
  });

  it('does not leave retired operations anywhere on the active documentation surface', () => {
    const active = activePaths.map(read).join('\n');

    expect(active).not.toContain('runtime-raiders-artifacts.sh publish');
    expect(active).not.toContain('release_sequence=2');
    expect(active).not.toContain('companion_version=0.2.0');
    expect(active).not.toContain('Install the sequence-2 canary');
    expect(active).not.toMatch(/docs\/superpowers\/(?:plans|specs)\/.*runtime-raiders/i);
  });

  it('labels every archived Runtime Raiders record as non-authoritative and do-not-execute', () => {
    expect(read('docs/archive/README.md')).toContain('ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE');

    for (const path of markdownFiles('docs/archive/runtime-raiders')) {
      expect(read(path)).toContain('ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE');
      expect(statSync(join(root, path)).isFile()).toBe(true);
    }
  });

  it('preserves historical release evidence and keeps retired sequence links inside the archive', () => {
    const historicalOperations = 'companion-operations-sequence-quartet.md';
    const cutover = read('docs/archive/runtime-raiders/pre-0.4.0/cutover.md');
    const authorization = read('docs/archive/runtime-raiders/pre-0.4.0/cutover-authorization-packet.md');
    const results = read('docs/archive/runtime-raiders/releases/employee-beta-0.4.5-0.4.6-results.md');

    for (const record of [cutover, authorization]) {
      expect(record).toContain(`](${historicalOperations})`);
      expect(record).toMatch(/historical/i);
    }

    for (const preservedFact of [
      'System Settings → Login Items showed **Runtime Raiders.app**.',
      'Direct office-network verification proved `raiders.local` resolution',
      'Verification passed 2,058 Node tests, the 225-case installer transaction',
    ]) expect(results).toContain(preservedFact);
  });
});
