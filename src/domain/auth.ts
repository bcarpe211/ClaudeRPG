import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

export function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}
