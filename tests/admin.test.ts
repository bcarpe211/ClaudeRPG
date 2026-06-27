import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, getSetting } from '../src/domain/settings';
import { ensureAdmin, verifyAdmin } from '../src/domain/admin';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

describe('ensureAdmin (env is the source of truth)', () => {
  it('seeds username + password when absent', () => {
    ensureAdmin(db, 'admin', 'secret');
    expect(verifyAdmin(db, 'admin', 'secret')).toBe(true);
  });

  it('updates the password when the configured env password changes', () => {
    ensureAdmin(db, 'admin', 'old-pass');
    expect(verifyAdmin(db, 'admin', 'old-pass')).toBe(true);
    // operator edits ADMIN_PASSWORD and restarts -> ensureAdmin runs again
    ensureAdmin(db, 'admin', 'new-pass');
    expect(verifyAdmin(db, 'admin', 'new-pass')).toBe(true);
    expect(verifyAdmin(db, 'admin', 'old-pass')).toBe(false);
  });

  it('leaves the stored hash untouched when the password is unchanged', () => {
    ensureAdmin(db, 'admin', 'secret');
    const hashBefore = getSetting(db, 'admin_password_hash');
    ensureAdmin(db, 'admin', 'secret'); // same password again
    const hashAfter = getSetting(db, 'admin_password_hash');
    expect(hashAfter).toBe(hashBefore); // no needless re-hash/rewrite
    expect(verifyAdmin(db, 'admin', 'secret')).toBe(true);
  });

  it('syncs a changed username from the env', () => {
    ensureAdmin(db, 'admin', 'secret');
    ensureAdmin(db, 'boss', 'secret');
    expect(getSetting(db, 'admin_username')).toBe('boss');
    expect(verifyAdmin(db, 'boss', 'secret')).toBe(true);
    expect(verifyAdmin(db, 'admin', 'secret')).toBe(false);
  });
});
