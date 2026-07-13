import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { CLASSES, getClass, classSpriteUrl } from '../../domain/classes';
import { createPlayer } from '../../domain/players';
import { buildSetupSnippet } from '../../domain/snippet';

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
  app.get('/', asyncHandler(async (_req, res) => {
    res.send(await renderPage('register', { title: 'Register', classes: classCards() }));
  }));

  app.post('/register', asyncHandler(async (req, res) => {
    const parsed = RegisterInput.safeParse(req.body);
    if (!parsed.success) {
      const classes = classCards();
      res
        .status(400)
        .send(
          await renderPage('register', {
            title: 'Register',
            classes,
            error: 'Please enter a name and pick a valid class.',
            name: typeof req.body?.name === 'string' ? req.body.name : '',
          }),
        );
      return;
    }
    const player = createPlayer(db, parsed.data, Date.now());
    const snippet = buildSetupSnippet({
      token: player.auth_token,
      host: config.otelHost,
      port: config.port,
    });
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
