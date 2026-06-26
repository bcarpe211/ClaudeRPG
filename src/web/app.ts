import express, { type Express } from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import type Database from 'better-sqlite3';
import type { Config } from '../config';
import { registerRegistrationRoutes } from './routes/registration';

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
  // registerCharacterRoutes(app, { db, config });   // Task 10
  // registerAdminRoutes(app, { db, config });        // Tasks 11-13

  return app;
}
