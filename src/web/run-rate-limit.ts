export interface RunRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type RunRateLimitScope =
  | 'enrollment-create'
  | 'enrollment-exchange'
  | 'unauthenticated-events'
  | 'unauthenticated-heartbeat'
  | 'device-events'
  | 'device-heartbeat';

interface ClientWindow {
  startedAt: number;
  requests: number;
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_TRACKED_CLIENTS = 2_048;

/** Bounded, timer-free fixed windows partitioned by route purpose and client. */
export function createRunRateLimiter(): {
  check(scope: RunRateLimitScope, client: string, now: number): RunRateLimitDecision;
} {
  const windows = new Map<string, ClientWindow>();

  const pruneExpired = (now: number): void => {
    for (const [key, window] of windows) {
      if (now < window.startedAt || now - window.startedAt >= WINDOW_MS) {
        windows.delete(key);
      }
    }
  };

  return {
    check(scope: RunRateLimitScope, client: string, now: number): RunRateLimitDecision {
      const key = `${scope}:${client}`;
      const existing = windows.get(key);
      if (
        existing
        && now >= existing.startedAt
        && now - existing.startedAt < WINDOW_MS
      ) {
        if (existing.requests >= MAX_REQUESTS_PER_WINDOW) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((existing.startedAt + WINDOW_MS - now) / 1_000),
            ),
          };
        }
        existing.requests += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (!existing && windows.size >= MAX_TRACKED_CLIENTS) {
        pruneExpired(now);
        if (windows.size >= MAX_TRACKED_CLIENTS) {
          return { allowed: false, retryAfterSeconds: 1 };
        }
      }
      windows.set(key, { startedAt: now, requests: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
