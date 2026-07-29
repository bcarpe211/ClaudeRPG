import { METRICS_INGEST_LIMITS } from '../domain/metrics-policy';

export interface MetricsRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface ClientWindow {
  startedAt: number;
  requests: number;
}

/**
 * In-memory fixed-window limiter for the public collector. It has no timer or
 * dependency: expired client entries are pruned when a new client arrives.
 */
export function createMetricsRateLimiter(): {
  check(client: string, now: number): MetricsRateLimitDecision;
} {
  const windows = new Map<string, ClientWindow>();

  const pruneExpired = (now: number): void => {
    for (const [client, window] of windows) {
      if (
        now < window.startedAt
        || now - window.startedAt >= METRICS_INGEST_LIMITS.rateLimitWindowMs
      ) {
        windows.delete(client);
      }
    }
  };

  return {
    check(client: string, now: number): MetricsRateLimitDecision {
      const existing = windows.get(client);
      if (
        existing
        && now >= existing.startedAt
        && now - existing.startedAt < METRICS_INGEST_LIMITS.rateLimitWindowMs
      ) {
        if (existing.requests >= METRICS_INGEST_LIMITS.maxRequestsPerWindow) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((
                existing.startedAt
                + METRICS_INGEST_LIMITS.rateLimitWindowMs
                - now
              ) / 1_000),
            ),
          };
        }
        existing.requests += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (!existing && windows.size >= METRICS_INGEST_LIMITS.maxTrackedClients) {
        pruneExpired(now);
        if (windows.size >= METRICS_INGEST_LIMITS.maxTrackedClients) {
          return { allowed: false, retryAfterSeconds: 1 };
        }
      }
      windows.set(client, { startedAt: now, requests: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
