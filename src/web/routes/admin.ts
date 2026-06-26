import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { verifyAdmin } from '../../domain/admin';

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

  // Placeholder dashboard; replaced by the player list in Task 12.
  app.get(
    '/admin',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      res.send(
        await renderPage('admin-login', { title: 'Admin', error: undefined }),
      );
    }),
  );
}
