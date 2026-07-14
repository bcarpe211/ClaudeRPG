import { describe, it, expect } from 'vitest';
import { SERVER_VERSION } from '../src/version';

describe('SERVER_VERSION', () => {
  it('is a non-empty string (git sha or start-time fallback)', () => {
    expect(typeof SERVER_VERSION).toBe('string');
    expect(SERVER_VERSION.length).toBeGreaterThan(0);
  });
});
