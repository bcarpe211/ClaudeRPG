import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const authority = read('docs/runtime-raiders/README.md');
const employee = read('docs/runtime-raiders/employee-beta.md');
const operations = read('docs/runtime-raiders/companion-operations.md');
const deployment = read('docs/runtime-raiders/server-deployment.md');

describe('Runtime Raiders documentation authority contract', () => {
  it('maps every current operating surface from one active index', () => {
    expect(authority).toContain('Executable scripts and their tests are the behavioral truth');
    expect(authority).toContain('[Employee beta](employee-beta.md)');
    expect(authority).toContain('[Companion operations](companion-operations.md)');
    expect(authority).toContain('[Server deployment](server-deployment.md)');
    expect(authority).toContain('[0.4.9 release evidence](releases/0.4.9.md)');
    expect(authority).toContain('docs/archive/');
  });

  it('keeps current server deployment paused, scoped, and recoverable', () => {
    expect(deployment).toContain('rluser@clauderpg.redlattice.com');
    expect(deployment).toContain('clean, reviewed, pinned to the approved commit');
    expect(deployment).toContain('game_state.paused=1');
    expect(deployment).toContain('Immediately before any mutation');
    expect(deployment).toContain('Preserve the existing database');
    expect(deployment).toContain('recoverable backup');
    expect(deployment).toContain('approved scoped pull and restart');
    expect(deployment).toContain('updater state');
    expect(deployment).toContain('database integrity and retained counts');
    expect(deployment).toContain('Restore the exact recorded prior checkout');
    expect(deployment).toContain('Companion publication is a separate procedure');
    expect(deployment).toContain('never enables collection');
  });

  it('does not leave retired sequence/quartet operations on the active surface', () => {
    const active = `${authority}\n${employee}\n${operations}\n${deployment}`;

    expect(active).not.toContain('runtime-raiders-artifacts.sh publish');
    expect(active).not.toContain('release_sequence=2');
    expect(active).not.toContain('companion_version=0.2.0');
    expect(active).not.toContain('Install the sequence-2 canary');
  });

  it('labels every archive root as non-authoritative and do-not-execute', () => {
    for (const path of [
      'docs/archive/README.md',
      'docs/archive/runtime-raiders/README.md',
      'docs/archive/runtime-raiders/pre-0.4.0/README.md',
      'docs/archive/runtime-raiders/releases/README.md',
      'docs/archive/runtime-raiders/executed/2026-08-26-companion-ux-and-reenrollment/README.md',
    ]) {
      const archive = read(path);
      expect(archive).toContain('ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE');
    }
  });
});
