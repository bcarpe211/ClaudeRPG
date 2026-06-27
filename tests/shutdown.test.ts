import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { openDb } from '../src/db/db';
import { gracefulShutdown } from '../src/web/shutdown';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('gracefulShutdown', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('checkpoints the WAL and closes the db despite an open persistent connection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-rpg-shutdown-'));
    const dbPath = join(dir, 'shutdown.db');
    const db = openDb(dbPath);

    // Write enough to grow a non-trivial WAL that needs checkpointing.
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
    const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
    const big = 'x'.repeat(2000);
    db.transaction(() => {
      for (let i = 0; i < 500; i++) insert.run(big);
    })();

    const walPath = dbPath + '-wal';
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThan(0);

    // A real server with a persistent, never-ending connection — like the
    // kiosk's SSE stream. This is what made the naive server.close() hang.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('event: hello\n\n'); // never res.end()
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;

    const accepted = new Promise<void>((resolve) => server.once('connection', () => resolve()));
    const sock = net.connect(port);
    sock.on('error', () => {}); // ignore reset when the server force-closes it
    sock.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await accepted; // server is now holding an open connection

    const timer = setInterval(() => {}, 1000);

    // Must complete synchronously without waiting for the connection to drain.
    gracefulShutdown('SIGTERM', { db, server, timer });

    // WAL flushed into the main file (truncated to 0 or removed on close).
    const walFlushed = !existsSync(walPath) || statSync(walPath).size === 0;
    expect(walFlushed).toBe(true);

    // DB is closed → further use throws.
    expect(() => db.prepare('SELECT 1').get()).toThrow();

    sock.destroy();
  });
});
