import type { Express, Request, Response, NextFunction } from 'express';
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
import { CLASSES, getClass } from '../../domain/classes';

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
      res.send(await renderPage('admin-login', { title: 'Admin Login' }));
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
          players: listPlayers(db),
        }),
      );
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
      gold: d.gold,
      disabled: d.disabled === '1' ? 1 : 0,
    };
    if (d.effective_tokens !== undefined) {
      patch.effective_tokens = d.effective_tokens;
    }
    updatePlayer(db, player.id, patch);
    res.redirect('/admin');
  });

  app.post('/admin/players/:id/delete', requireAdmin, (req, res) => {
    deletePlayer(db, Number(req.params.id));
    res.redirect('/admin');
  });
}
