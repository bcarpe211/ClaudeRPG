import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './settings';
import { hashPassword, verifyPassword } from './auth';

const USER_KEY = 'admin_username';
const HASH_KEY = 'admin_password_hash';

/** Seed admin credentials if not already present. */
export function ensureAdmin(
  db: Database.Database,
  username: string,
  password: string,
): void {
  if (getSetting(db, HASH_KEY)) return;
  setSetting(db, USER_KEY, username);
  setSetting(db, HASH_KEY, hashPassword(password));
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
