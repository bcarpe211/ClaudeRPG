import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { CLASSES, getClass, classSpriteUrl } from '../../domain/classes';
import { createPlayer } from '../../domain/players';
import { createEnrollment } from '../../domain/raider-enrollment';
import { buildTvState } from '../tvview';
import { formatCompact } from '../../domain/format';
import type { RunSurface } from '../../domain/run-events';

const RegisterInput = z.object({
  name: z.string().trim().min(1).max(40),
  class_key: z.string().refine((k) => !!getClass(k), 'unknown class'),
  gender: z.enum(['M', 'F']),
});

// Each class with both gender sprite URLs, so the form can swap the preview client-side.
const classCards = () =>
  CLASSES.map((c) => ({
    key: c.key,
    name: c.name,
    spriteM: classSpriteUrl(c.key, 'M'),
    spriteF: classSpriteUrl(c.key, 'F'),
  }));

const PUBLIC_SURFACE_LABELS: Readonly<Partial<Record<RunSurface, string>>> = {
  codex_desktop: 'Codex Desktop',
  codex_cli: 'Codex CLI',
};

interface LandingRunSupport {
  line: string;
  runStep: string;
}

function landingRunSupport(surfaces: readonly RunSurface[]): LandingRunSupport | null {
  const labels = surfaces.map((surface) => PUBLIC_SURFACE_LABELS[surface]);
  if (labels.length === 0 || labels.some((label) => label === undefined)) return null;

  const names = labels as string[];
  const supportList = names.length === 1
    ? names[0]
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  const stepNames = names.map((name) => name === 'Codex CLI' ? 'CLI' : name);
  const stepList = stepNames.length === 1
    ? stepNames[0]
    : stepNames.length === 2
      ? `${stepNames[0]} or ${stepNames[1]}`
      : `${stepNames.slice(0, -1).join(', ')}, or ${stepNames.at(-1)}`;
  return {
    line: `Supported Run surfaces: ${supportList}.`,
    runStep: `Use ${stepList}; your Runs generate Raid Power.`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildInstallCommand(publicUrl: string, oneTimeCode: string): string {
  return `curl -fsSL ${shellQuote(`${publicUrl}/install.sh`)} | sh -s -- --code ${shellQuote(oneTimeCode)}`;
}

export function registerRegistrationRoutes(
  app: Express,
  { db, config, slotmapsDir }: AppDeps,
): void {
  // Landing page — the public front door with a live snapshot of the current battle.
  app.get('/', asyncHandler(async (_req, res) => {
    const state = buildTvState(db, Date.now(), {
      spritesDir: config.spritesDir,
      slotmapsDir,
    });
    const classes = CLASSES.map((c) => ({ key: c.key, name: c.name, sprite: classSpriteUrl(c.key, 'M') }));
    let boss = null;
    if (state.encounter && !state.paused) {
      const e = state.encounter;
      const active = state.players.filter((p) => !p.disabled);
      const d = db.prepare('SELECT theme FROM dungeons WHERE id=?').get(state.dungeonId) as
        { theme: string } | undefined;
      boss = {
        name: e.name,
        sprite: e.creatureUrl,
        hpPct: Math.max(0, Math.min(100, Math.round((e.hp / e.maxHp) * 100))),
        hpText: `${formatCompact(e.hp)} / ${formatCompact(e.maxHp)}`,
        count: active.length,
        avatars: active.slice(0, 7).map((p) => p.avatarUrl),
        location: d?.theme ?? 'The dungeon',
      };
    }
    const runSupport = landingRunSupport(config.enabledRunSurfaces);
    res.send(
      await renderPage('landing', {
        title: 'Home',
        frame: 'full',
        styles: ['landing.css'],
        classes,
        boss,
        supportedSurfaceLine: runSupport?.line ?? null,
        runStep: runSupport?.runStep ?? null,
      }),
    );
  }));

  // Registration form (moved off `/`). `?class=` preselects a Raider class from the landing.
  app.get('/register', asyncHandler(async (_req, res) => {
    const selected = getClass(String(_req.query.class ?? '')) ? String(_req.query.class) : 'knight';
    res.send(await renderPage('register', { title: 'Create Your Raider', classes: classCards(), selected }));
  }));

  app.post('/register', asyncHandler(async (req, res) => {
    const parsed = RegisterInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(
        await renderPage('register', {
          title: 'Create Your Raider',
          classes: classCards(),
          selected: getClass(String(req.body?.class_key ?? '')) ? String(req.body.class_key) : 'knight',
          error: 'Please enter a name and pick a valid class.',
          name: typeof req.body?.name === 'string' ? req.body.name : '',
        }),
      );
      return;
    }
    const now = Date.now();
    const player = createPlayer(db, parsed.data, now);
    const enrollment = createEnrollment(db, player.id, now);
    res.send(
      await renderPage('registered', {
        title: 'Your Raider',
        player,
        className: getClass(player.class_key)!.name,
        installCommand: buildInstallCommand(config.publicUrl, enrollment.code),
      }),
    );
  }));
}
