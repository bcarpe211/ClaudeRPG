import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { verifyAdmin } from '../../domain/admin';
import {
  listPlayers,
  getPlayerById,
  updatePlayer,
  deletePlayer,
} from '../../domain/players';
import { setGoldBalance } from '../../domain/goldledger';
import { CLASSES, getClass } from '../../domain/classes';
import {
  DEFAULT_SETTINGS,
  getAllSettings,
  setSetting,
} from '../../domain/settings';
import { groupedSettings } from '../../domain/settings-meta';
import { validateRewardConfig } from '../../domain/rewards';
import { buildPotionLabReport } from '../../domain/potionlab';
import { nextOfficeMidnight, officeDayKey, officeDayStart } from '../../domain/office-time';

// Augment the session type with our admin flag.
declare module 'express-session' {
  interface SessionData {
    isAdmin?: boolean;
  }
}

const LoginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const REWARD_SETTING_KEYS = [
  'reward_work_pct',
  'reward_damage_pct',
  'reward_podium_first_pct',
  'reward_podium_second_pct',
  'reward_podium_third_pct',
] as const;

const OptionalQueryString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().optional(),
);

const PotionLabQuery = z.object({
  from: OptionalQueryString.refine(
    (value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value),
    'invalid from date',
  ),
  to: OptionalQueryString.refine(
    (value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value),
    'invalid to date',
  ),
  player: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.coerce.number().int().positive().optional(),
  ),
  sku: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.enum(['potion_gold_t1', 'potion_damage_t1']).optional(),
  ),
});

function officeDateStart(
  value: string | undefined,
  timeZone: string,
): number | undefined {
  if (value === undefined) return undefined;
  const utcNoon = Date.parse(`${value}T12:00:00.000Z`);
  if (
    !Number.isSafeInteger(utcNoon)
    || new Date(utcNoon).toISOString().slice(0, 10) !== value
  ) return undefined;
  for (let offset = -2; offset <= 2; offset += 1) {
    const candidate = utcNoon + offset * 86_400_000;
    if (officeDayKey(candidate, timeZone) === value) {
      return officeDayStart(candidate, timeZone);
    }
  }
  return undefined;
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.session.isAdmin) {
    next();
    return;
  }
  res.redirect('/admin/login');
}

export function registerAdminRoutes(app: Express, deps: AppDeps): void {
  const { db } = deps;

  app.get(
    '/admin/login',
    asyncHandler(async (_req, res) => {
      res.send(await renderPage('admin-login', { title: 'Admin Login', frame: 'lite' }));
    }),
  );

  app.post(
    '/admin/login',
    asyncHandler(async (req, res) => {
      const parsed = LoginInput.safeParse(req.body);
      if (
        !parsed.success ||
        !verifyAdmin(db, parsed.data.username, parsed.data.password)
      ) {
        res.status(401).send(
          await renderPage('admin-login', {
            title: 'Admin Login',
            frame: 'lite',
            error: 'Invalid username or password.',
          }),
        );
        return;
      }
      req.session.isAdmin = true;
      res.redirect('/admin');
    }),
  );

  app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  app.get(
    '/admin',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      res.send(
        await renderPage('admin-players', {
          title: 'Players',
          frame: 'lite',
          players: listPlayers(db),
        }),
      );
    }),
  );

  app.get(
    '/admin/potions',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const parsed = PotionLabQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).send('Invalid Potion Lab filters');
        return;
      }
      const from = officeDateStart(parsed.data.from, deps.config.officeTimeZone);
      const toStart = officeDateStart(parsed.data.to, deps.config.officeTimeZone);
      if (
        (parsed.data.from !== undefined && from === undefined)
        || (parsed.data.to !== undefined && toStart === undefined)
        || (from !== undefined && toStart !== undefined && from > toStart)
      ) {
        res.status(400).send('Invalid Potion Lab filters');
        return;
      }
      const to = toStart === undefined
        ? undefined
        : nextOfficeMidnight(toStart, deps.config.officeTimeZone) - 1;
      const report = buildPotionLabReport(db, {
        from,
        to,
        playerId: parsed.data.player,
        sku: parsed.data.sku,
        timeZone: deps.config.officeTimeZone,
      });
      res.set('Cache-Control', 'private, no-store');
      res.send(await renderPage('admin-potions', {
        title: 'Potion Lab',
        frame: 'lite',
        report,
        players: listPlayers(db),
        filters: parsed.data,
      }));
    }),
  );

  app.get(
    '/admin/players/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const player = getPlayerById(db, Number(req.params.id));
      if (!player) {
        res.status(404).send('Not found');
        return;
      }
      res.send(
        await renderPage('admin-player-edit', {
          title: `Edit ${player.name}`,
          frame: 'lite',
          player,
          classes: CLASSES,
        }),
      );
    }),
  );

  const EditInput = z.object({
    name: z.string().trim().min(1).max(40),
    class_key: z.string().refine((k) => !!getClass(k), 'unknown class'),
    gender: z.enum(['M', 'F']),
    level: z.coerce.number().int().min(1),
    gold: z.coerce.number().int().min(0),
    effective_tokens: z.coerce.number().int().min(0).optional(),
    disabled: z.union([z.literal('1'), z.undefined()]),
  });

  app.post('/admin/players/:id', requireAdmin, (req, res) => {
    const player = getPlayerById(db, Number(req.params.id));
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    const parsed = EditInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const d = parsed.data;
    const patch: Parameters<typeof updatePlayer>[2] = {
      name: d.name,
      class_key: d.class_key,
      gender: d.gender,
      level: d.level,
      disabled: d.disabled === '1' ? 1 : 0,
    };
    if (d.effective_tokens !== undefined) {
      patch.effective_tokens = d.effective_tokens;
    }
    updatePlayer(db, player.id, patch);
    setGoldBalance(db, player.id, d.gold, randomUUID(), Date.now());
    res.redirect('/admin');
  });

  app.post('/admin/players/:id/delete', requireAdmin, (req, res) => {
    deletePlayer(db, Number(req.params.id));
    res.redirect('/admin');
  });

  app.get(
    '/admin/settings',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const all = getAllSettings(db);
      // Only expose the known game knobs, never admin_* credential keys.
      const values: Record<string, string> = {};
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        values[key] = all[key] ?? DEFAULT_SETTINGS[key];
      }
      res.send(await renderPage('admin-settings', { title: 'Settings', frame: 'lite', groups: groupedSettings(values) }));
    }),
  );

  app.post('/admin/settings', requireAdmin, (req, res) => {
    const hasRewardSetting = REWARD_SETTING_KEYS.some((key) => req.body?.[key] !== undefined);
    if (hasRewardSetting) {
      const submitted = REWARD_SETTING_KEYS.map((key) => req.body?.[key]);
      if (submitted.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
        res.status(400).send('All reward percentages are required');
        return;
      }
      try {
        validateRewardConfig({
          workPct: Number(submitted[0]),
          damagePct: Number(submitted[1]),
          podiumPct: [
            Number(submitted[2]),
            Number(submitted[3]),
            Number(submitted[4]),
          ],
        });
      } catch {
        res.status(400).send('Reward percentages must be non-negative and total 100');
        return;
      }
    }
    db.transaction(() => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const v = req.body?.[key];
        if (typeof v === 'string' && v.length > 0) setSetting(db, key, v);
      }
    })();
    res.redirect('/admin/settings');
  });
}
