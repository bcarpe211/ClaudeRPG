import express, { type Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app';
import type { TvHub } from '../tvhub';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerTvRoutes(app: Express, _deps: AppDeps, hub: TvHub): void {
  app.get('/tv', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'tv', 'index.html'));
  });

  app.get('/tv/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const client = { write: (chunk: string) => res.write(chunk) };
    hub.addClient(client, Date.now());
    req.on('close', () => hub.removeClient(client));
  });
}
