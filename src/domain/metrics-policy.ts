/**
 * Public OTLP ingestion budgets.
 *
 * Claude Code normally exports a small handful of token points every five
 * seconds. These limits leave substantial burst headroom: 1,024 points per
 * export, 64 attributes per OTLP attribute collection, and 600 requests per
 * minute (about 50 five-second exporters even when a reverse proxy presents
 * them under one client address).
 */
export const METRICS_INGEST_LIMITS = {
  maxBodyBytes: 16 * 1024 * 1024,
  maxDecompressedBodyBytes: 64 * 1024 * 1024,
  maxDataPoints: 1_024,
  maxAttributesPerCollection: 64,
  maxIdentityFieldLength: 256,
  rateLimitWindowMs: 60_000,
  maxRequestsPerWindow: 600,
  maxTrackedClients: 2_048,
} as const;
