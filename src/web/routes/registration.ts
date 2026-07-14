import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { CLASSES, getClass, classSpriteUrl } from '../../domain/classes';
import { createPlayer } from '../../domain/players';
import { buildSetupSnippet } from '../../domain/snippet';
import { buildTvState } from '../tvview';
import { formatCompact } from '../../domain/format';

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

export function registerRegistrationRoutes(
  app: Express,
  { db, config }: AppDeps,
): void {
  // Landing page — the public front door with a live snapshot of the current battle.
  app.get('/', asyncHandler(async (_req, res) => {
    const state = buildTvState(db, Date.now());
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
    const snippet = buildSetupSnippet({ token: '<your-token>', endpoint: config.publicUrl });
    res.send(
      await renderPage('landing', {
        title: 'ClaudeRPG',
        frame: 'full',
        styles: ['landing.css'],
        classes,
        boss,
        snippet,
      }),
    );
  }));

  // Registration form (moved off `/`). `?class=` preselects a fighter from the landing.
  app.get('/register', asyncHandler(async (_req, res) => {
    const selected = getClass(String(_req.query.class ?? '')) ? String(_req.query.class) : 'knight';
    res.send(await renderPage('register', { title: 'Register', classes: classCards(), selected }));
  }));

  app.post('/register', asyncHandler(async (req, res) => {
    const parsed = RegisterInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send(
        await renderPage('register', {
          title: 'Register',
          classes: classCards(),
          selected: getClass(String(req.body?.class_key ?? '')) ? String(req.body.class_key) : 'knight',
          error: 'Please enter a name and pick a valid class.',
          name: typeof req.body?.name === 'string' ? req.body.name : '',
        }),
      );
      return;
    }
    const player = createPlayer(db, parsed.data, Date.now());
    const snippet = buildSetupSnippet({ token: player.auth_token, endpoint: config.publicUrl });
    res.send(
      await renderPage('registered', {
        title: 'Registered',
        player,
        className: getClass(player.class_key)!.name,
        snippet,
      }),
    );
  }));
}
