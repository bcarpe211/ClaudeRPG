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
  'src/web/routes/character.ts',
  'src/domain/settings-meta.ts',
  'src/domain/playerhub.ts',
  'src/domain/shopview.ts',
  'README.md',
];
const pathScopedRules = [
  { path: 'src/web/public/player-hub.js', pattern: /['"`][^'"`]*\s+tokens?\b/i, label: 'token unit' },
  { path: 'src/web/public/tv/tv.js', pattern: /\btok\b/i, label: 'tok unit' },
  { path: 'src/web/public/tv/tv.js', pattern: /awaiting adventurers/i, label: 'adventurer rest copy' },
  { path: 'src/web/routes/character.ts', pattern: /Character Login/i, label: 'Character Login' },
  { path: 'src/web/routes/character.ts', pattern: /No character found for that token/i, label: 'character token error' },
  { path: 'src/web/views/character-sheet.ejs', pattern: /(?:Delete|your|this) character/i, label: 'character deletion copy' },
  { path: 'src/web/views/character-login.ejs', pattern: /Raider sheet/i, label: 'Raider sheet' },
  { path: 'src/web/views/registered.ejs', pattern: /Raider sheet/i, label: 'Raider sheet' },
  { path: 'src/web/views/character-wardrobe.ejs', pattern: /Live character dye preview/i, label: 'character dye aria' },
  { path: 'src/web/public/dye.js', pattern: /Character session expired/i, label: 'character session error' },
  { path: 'src/web/views/landing.ejs', pattern: /\badventurers?\b/i, label: 'adventurer landing count' },
  { path: 'src/web/views/character-sheet.ejs', pattern: /dungeon is not accepting work/i, label: 'work-based potion timing' },
  { path: 'src/web/public/player-hub.js', pattern: /dungeon is not accepting work/i, label: 'work-based potion timing' },
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
    const relativeFile = relative(repositoryRoot, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(allowMarker)) return;
      const normalizedLine = line.toLowerCase();
      for (const term of staleTerms) {
        if (normalizedLine.includes(term.toLowerCase())) {
          violations.push(`${relative(repositoryRoot, file)}:${index + 1}: stale player copy: ${term}`);
        }
      }
      for (const rule of pathScopedRules) {
        if (relativeFile === rule.path && rule.pattern.test(line)) {
          violations.push(`${relativeFile}:${index + 1}: stale player copy: ${rule.label}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
}
