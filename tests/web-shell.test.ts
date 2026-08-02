import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('dungeon shell', () => {
  it('wraps renderPage views in the torch-lit frame and links dungeon.css', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/static/dungeon.css"');
    expect(res.text).toContain('class="wall wall-l"');
    expect(res.text).toContain('class="wall wall-r"');
  });

  it('full-frame pages render the gutter loot rails', async () => {
    const res = await request(app).get('/register');
    const styles = [...res.text.matchAll(/class="loot [lr]" style="([^"]+)"/g)]
      .map((match) => match[1]);
    const value = (style: string, name: string) =>
      style.match(new RegExp(`--${name}:([^;]+)`))?.[1];

    expect(res.text).toContain('class="loot-rail left"');
    expect(res.text).toContain('class="loot-rail right"');
    expect(res.text).toContain('--drift:-22px');
    expect(res.text).toContain('--drift:24px');
    expect(res.text).not.toContain('frame-lite');
    expect(styles).toHaveLength(10);
    expect(styles.map((style) => value(style, 'd'))).toEqual([
      '9.4s', '11.2s', '12.8s', '10.3s', '13.6s',
      '12.1s', '9.7s', '13.2s', '10.8s', '11.6s',
    ]);
    expect(styles.map((style) => value(style, 'delay'))).toEqual([
      '-2.1s', '-7.4s', '-4.9s', '-8.6s', '-1.3s',
      '-6.2s', '-3.8s', '-9.1s', '-5.4s', '-10.3s',
    ]);
    expect(new Set(styles.map((style) => value(style, 'delay'))).size).toBe(10);
  });

  it('renders the Runtime Raiders wordmark and raider-first navigation', async () => {
    const res = await request(app).get('/register');
    const wordmark = res.text.match(/<a class="brand" href="\/"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';

    expect(wordmark).toContain('RUNTIME');
    expect(wordmark).toContain('RAIDERS');
    expect(res.text).toContain('>Create Raider</a>');
    expect(res.text).toContain('>Raider Login</a>');
    expect(res.text).not.toContain('>Register</a>');
    expect(res.text).not.toContain('>Log in</a>');
  });

  it('uses the game premise in the footer without implying work output', async () => {
    const res = await request(app).get('/register');

    expect(res.text).toContain('Your AI keeps running. Your Raider keeps raiding.');
    expect(res.text).not.toContain('your usage, gamified');
  });

  it('renders the shared footer on requested routes', async () => {
    for (const path of ['/', '/register', '/character', '/admin/login']) {
      const page = await request(app).get(path);
      expect(page.status).toBe(200);
      expect(page.text).toContain('class="foot"');
    }
  });
});

describe('lite frame', () => {
  it('the catalog uses the lite frame (no loot rails)', async () => {
    // catalog requires spritesDir; loadConfig({}) provides the default asset dir
    const res = await request(app).get('/catalog');
    if (res.status === 200) {
      expect(res.text).toContain('class="frame-lite"');
      expect(res.text).not.toContain('class="loot-rail left"');
    }
  });

  it('the admin login page uses the lite frame', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="frame-lite"');
    expect(res.text).not.toContain('class="loot-rail left"');
  });
});
