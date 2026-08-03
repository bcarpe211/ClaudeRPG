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
const piSetupPath = 'docs/PI_SETUP.md';
const cutoverPlanPath = 'docs/superpowers/plans/2026-08-01-runtime-raiders-internal-deployment-cutover.md';
const operatorGuideTargets = [piSetupPath, cutoverPlanPath];
const rawPullCommandPattern = /\bgit\s+pull(?:\s+--ff-only)?\b/i;
const gameRestartCommandPattern = /\b(?:sudo\s+)?systemctl\s+restart\s+claude-rpg(?:\.service)?\b/i;
const safeReleaseContextPattern = /\b(?:do not|never|retired|runbook|pinned[- ]SHA|separately authorized)\b/i;
const instructionBoundaryPattern = /^\s*(?:$|#{1,6}\s|```)/;
const splitRecipeWindowLines = 3;
const operatorInstructionRules = [
  {
    pattern: /sudo\s+install\b.*\bclaude-rpg-autoupdate\b/i,
    label: 'install moving-main updater',
  },
  {
    pattern: /sudo\s+(?:cp|install)\b.*\bclaude-rpg-autoupdate\.(?:service|timer)\b/i,
    label: 'install moving-main updater',
  },
  {
    pattern: /sudo\s+systemctl\s+enable(?:\s+--now)?\s+claude-rpg-autoupdate\.timer\b/i,
    label: 'enable moving-main updater',
  },
  {
    pattern: /sudo\s+systemctl\s+start\s+claude-rpg-autoupdate\b/i,
    label: 'force-run moving-main updater',
  },
  {
    pattern: /\brestore\s+(?:the\s+)?(?:auto-update|updater)\s+timer\b/i,
    allowPattern: /\b(?:do not|never|must not)\b/i,
    label: 'restore moving-main updater',
  },
  {
    pattern: /\b(?:enable|start)\s+(?:the\s+)?(?:current\s+)?(?:moving[- ](?:main|`main`)\s+)?(?:auto-update|updater)\s+(?:timer|oneshot|service)\b/i,
    allowPattern: /\b(?:do not|never|must not|disabled|inactive)\b/i,
    label: 'activate moving-main updater',
  },
  {
    paths: [piSetupPath],
    pattern: /\bgit\s+pull(?:\s+--ff-only)?\b.*(?:&&|;)\s*(?:sudo\s+)?systemctl\s+restart\s+claude-rpg(?:\.service)?\b/i,
    label: 'raw pull-restart release',
  },
  {
    paths: [piSetupPath],
    pattern: /\b(?:pastes?|installs?|sources?|runs?|uses?)\b[^.\n]*\b(?:setup|telemetry|otel)\s+snippet\b/i,
    allowPattern: /\b(?:do not|never|retired|remove|removed|unsupported|unavailable)\b/i,
    label: 'install legacy telemetry snippet',
  },
  {
    paths: [piSetupPath],
    pattern: /\bClaude Code\b[^.\n]*\btoken usage\b[^.\n]*\bstreams?\b/i,
    allowPattern: /\b(?:do not|never|retired|remove|removed|unsupported|unavailable)\b/i,
    label: 'score Claude Code token stream',
  },
  {
    paths: [piSetupPath],
    pattern: /\brpg_(?:on|off)\b/i,
    allowPattern: /\b(?:do not use|must not use|retired|remove|removed|unsupported|unavailable)\b/i,
    label: 'use legacy rpg command',
  },
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

for (const target of operatorGuideTargets) {
  for (const file of filesUnder(resolve(repositoryRoot, target))) {
    const relativeFile = relative(repositoryRoot, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of operatorInstructionRules) {
        if (rule.paths && !rule.paths.includes(relativeFile)) continue;
        if (rule.pattern.test(line) && !(rule.allowPattern?.test(line))) {
          violations.push(`${relativeFile}:${index + 1}: stale operator instruction: ${rule.label}`);
        }
      }
    });
    if (relativeFile === piSetupPath) {
      lines.forEach((line, index) => {
        if (!rawPullCommandPattern.test(line) || safeReleaseContextPattern.test(line)) return;
        const lastIndex = Math.min(lines.length - 1, index + splitRecipeWindowLines);
        for (let candidateIndex = index + 1; candidateIndex <= lastIndex; candidateIndex += 1) {
          const candidate = lines[candidateIndex];
          if (instructionBoundaryPattern.test(candidate)) break;
          const instructionBlock = lines.slice(index, candidateIndex + 1).join(' ');
          if (safeReleaseContextPattern.test(instructionBlock)) break;
          if (gameRestartCommandPattern.test(candidate)) {
            violations.push(`${relativeFile}:${index + 1}: stale operator instruction: raw pull-restart release`);
            break;
          }
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
}
