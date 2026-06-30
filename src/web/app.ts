import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import type Database from 'better-sqlite3';
import type { Config } from '../config';
import { registerRegistrationRoutes } from './routes/registration';
import { registerCharacterRoutes } from './routes/character';
import { registerAdminRoutes } from './routes/admin';
import { registerMetricsRoutes } from './routes/metrics';
import { TvHub } from './tvhub';
import { registerTvRoutes } from './routes/tv';
import { registerCatalogRoutes } from './routes/catalog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(__dirname, 'views');

export interface AppDeps {
  db: Database.Database;
  config: Config;
}

// Renders a page template, wraps it in layout.ejs, returns HTML.
export async function renderPage(
  view: string,
  data: Record<string, unknown>,
): Promise<string> {
  const body = await ejs.renderFile(path.join(VIEWS, `${view}.ejs`), data);
  return ejs.renderFile(path.join(VIEWS, 'layout.ejs'), {
    title: data.title ?? 'ClaudeRPG',
    body,
  });
}

export function createApp({ db, config }: AppDeps): Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use('/static', express.static(path.join(__dirname, 'public')));
  app.use('/sprites', express.static(path.resolve(config.spritesDir)));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  registerRegistrationRoutes(app, { db, config });
  registerCharacterRoutes(app, { db, config });
  registerAdminRoutes(app, { db, config });
  registerMetricsRoutes(app, { db, config });

  const tvHub = new TvHub(db);
  registerTvRoutes(app, { db, config }, tvHub);
  (app as unknown as { tvHub: TvHub }).tvHub = tvHub;

  registerCatalogRoutes(app, { db, config });

  // Final safety net: turn any handler error into a 500 instead of crashing.
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      console.error('[ClaudeRPG] request error:', err);
      if (res.headersSent) return;
      res.status(500).send('Internal Server Error');
    },
  );

  return app;
}
