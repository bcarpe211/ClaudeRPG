import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = process.env.RUNTIME_RAIDERS_COPY_ROOT
  ? resolve(process.env.RUNTIME_RAIDERS_COPY_ROOT)
  : resolve(fileURLToPath(new URL('../..', import.meta.url)));
const allowMarker = 'runtime-raiders-copy-allow';
const staleTerms = [
  'ClaudeRPG',
  'Claude Code only',
  'rpg_on',
  'rpg_off',
  'effective tokens',
  'Total tokens',
];
const scanTargets = [
  'src/web/views',
  'src/web/public',
  'src/domain/settings-meta.ts',
  'src/domain/playerhub.ts',
  'README.md',
];

function filesUnder(target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(resolve(target, entry.name)) : [resolve(target, entry.name)],
  );
}

const violations = [];
for (const target of scanTargets) {
  for (const file of filesUnder(resolve(repositoryRoot, target))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(allowMarker)) return;
      const normalizedLine = line.toLowerCase();
      for (const term of staleTerms) {
        if (normalizedLine.includes(term.toLowerCase())) {
          violations.push(`${relative(repositoryRoot, file)}:${index + 1}: stale player copy: ${term}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
}
