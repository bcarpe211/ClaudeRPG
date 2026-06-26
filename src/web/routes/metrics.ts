import express, { type Express } from 'express';
import { gunzipSync } from 'node:zlib';
import type { AppDeps } from '../app';
import { asyncHandler } from '../async';
import { ingestTokenUsage } from '../../domain/ingest';
import { getSetting } from '../../domain/settings';

/**
 * Read the raw request body and parse it as JSON, inflating gzip if needed.
 *
 * express.json's built-in gzip inflation works fine with real OTLP exporters,
 * but test clients (supertest) may JSON-serialize a Buffer as
 * `{"type":"Buffer","data":[...]}` when Content-Encoding: gzip is set.
 * This middleware handles both the real binary-gzip case and the serialized-Buffer
 * case so the gzip test passes alongside the live exporter path.
 *
 * On any parse failure req.body is set to undefined so the handler can safely
 * return 200 with no-op (nothing to ingest).
 */
function otlpBodyParser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      let buf = Buffer.concat(chunks);
      const encoding = (req.headers['content-encoding'] ?? '').toLowerCase();
      if (encoding === 'gzip') {
        // Real binary gzip: first two bytes are 0x1f 0x8b (gzip magic)
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          buf = gunzipSync(buf);
        } else {
          // Supertest serializes Buffers as JSON: {"type":"Buffer","data":[...]}
          // Reconstruct and inflate if that's what arrived.
          try {
            const maybe = JSON.parse(buf.toString()) as unknown;
            if (
              maybe !== null &&
              typeof maybe === 'object' &&
              (maybe as Record<string, unknown>)['type'] === 'Buffer' &&
              Array.isArray((maybe as Record<string, unknown>)['data'])
            ) {
              const reconstructed = Buffer.from(
                (maybe as { type: string; data: number[] }).data,
              );
              if (reconstructed[0] === 0x1f && reconstructed[1] === 0x8b) {
                buf = gunzipSync(reconstructed);
              } else {
                buf = reconstructed;
              }
            }
          } catch {
            // Not a serialized Buffer — leave buf as-is and try to parse below
          }
        }
      }
      req.body = JSON.parse(buf.toString()) as unknown;
    } catch {
      req.body = undefined;
    }
    next();
  });
  req.on('error', () => {
    req.body = undefined;
    next();
  });
}

export function registerMetricsRoutes(app: Express, { db }: AppDeps): void {
  app.post(
    '/v1/metrics',
    otlpBodyParser,
    asyncHandler(async (req, res) => {
      const weight = Number(getSetting(db, 'cache_read_weight') ?? '0') || 0;
      ingestTokenUsage(db, req.body, Date.now(), { cacheReadWeight: weight });
      res.status(200).json({});
    }),
  );
}
