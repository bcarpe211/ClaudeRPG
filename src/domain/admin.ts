import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './settings';
import { hashPassword, verifyPassword } from './auth';

const USER_KEY = 'admin_username';
const HASH_KEY = 'admin_password_hash';

/**
 * Sync the stored admin credentials to the configured env values so an operator
 * can change ADMIN_USERNAME / ADMIN_PASSWORD and restart for it to take effect.
 * The env is the source of truth: the username is always synced, and the
 * password hash is (re)written whenever the configured password no longer
 * verifies against the stored hash (first boot, or a changed password). When the
 * password is unchanged the existing (salted) hash is left untouched.
 */
export function ensureAdmin(
  db: Database.Database,
  username: string,
  password: string,
): void {
  setSetting(db, USER_KEY, username);
  const existing = getSetting(db, HASH_KEY);
  if (!existing || !verifyPassword(password, existing)) {
    setSetting(db, HASH_KEY, hashPassword(password));
  }
}

export function verifyAdmin(
  db: Database.Database,
  username: string,
  password: string,
): boolean {
  const u = getSetting(db, USER_KEY);
  const h = getSetting(db, HASH_KEY);
  if (!u || !h) return false;
  return username === u && verifyPassword(password, h);
}
