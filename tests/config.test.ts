import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.dbPath).toBe('./data/claude-rpg.db');
    expect(c.adminUsername).toBe('admin');
    expect(c.otelHost).toBe('claude-rpg.local');
    expect(typeof c.sessionSecret).toBe('string');
    expect(c.sessionSecret.length).toBeGreaterThan(10);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      PORT: '9000',
      DB_PATH: '/tmp/x.db',
      ADMIN_USERNAME: 'boss',
      ADMIN_PASSWORD: 'secret',
      OTEL_ENDPOINT_HOST: 'rpg.lan',
      SESSION_SECRET: 'fixedsecretvalue',
    });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.adminUsername).toBe('boss');
    expect(c.adminPassword).toBe('secret');
    expect(c.otelHost).toBe('rpg.lan');
    expect(c.sessionSecret).toBe('fixedsecretvalue');
  });
});
