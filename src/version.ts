import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root — this file lives at <root>/src/version.ts.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The deployed commit, resolved once at process start. Sent to the /tv kiosk so it
// can reload itself when a redeploy restarts the server on a new commit (see
// docs/superpowers/specs/2026-07-14-tv-auto-reload-design.md). Falls back to the
// process start time if git can't be read (not a checkout / git missing), which
// still yields a distinct value per process.
function resolveVersion(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // fall through to the timestamp fallback
  }
  return Date.now().toString(36);
}

export const SERVER_VERSION: string = resolveVersion();
