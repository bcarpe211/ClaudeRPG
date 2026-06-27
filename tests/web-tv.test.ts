import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); app = createApp({ db, config: loadConfig({}) }); });

describe('TV routes', () => {
  it('GET /tv serves the kiosk page', async () => {
    const res = await request(app).get('/tv');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<canvas');
    expect(res.text).toContain('/static/tv/tv.js');
  });

  it('exposes a tvHub on the app for the tick loop', () => {
    expect((app as any).tvHub).toBeDefined();
    expect(typeof (app as any).tvHub.broadcast).toBe('function');
  });

  it('GET /tv/stream opens an SSE stream with the right headers', async () => {
    // SSE never ends — use a raw http request against a listened server,
    // read the first chunk (headers + initial data), then destroy the socket.
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(app).listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.get(`http://localhost:${addr.port}/tv/stream`, (res) => {
          try {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
          } catch (e) {
            req.destroy();
            server.close(() => reject(e));
            return;
          }
          req.destroy();
          server.close(() => resolve());
        });
        req.on('error', (err) => {
          // ECONNRESET is expected when we destroy mid-stream
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            server.close(() => reject(err));
          }
        });
      });
    });
  });
});
