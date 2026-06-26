import { describe, it, expect } from 'vitest';
import { randomToken, hashPassword, verifyPassword } from '../src/domain/auth';

describe('auth', () => {
  it('generates unique, url-safe tokens', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it('hashes and verifies passwords', () => {
    const hash = hashPassword('hunter2');
    expect(hash).not.toBe('hunter2');
    expect(verifyPassword('hunter2', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });
});
