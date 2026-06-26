import express, { type Express } from 'express';
import { gunzipSync } from 'node:zlib';
import type { AppDeps } from '../app';
import { asyncHandler } from '../async';
import { ingestTokenUsage } from '../../domain/ingest';
import { getSetting } from '../../domain/settings';

const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB safety cap

/**
 * Collect the raw request body and parse it as OTLP/JSON, transparently
 * gunzipping when the client sent gzip (real OTLP exporters set
 * `Content-Encoding: gzip`; we also sniff the gzip magic bytes defensively).
 *
 * Robust by design: any oversized, truncated, or malformed body results in
 * `req.body = undefined` (the handler then returns 200 with nothing ingested),
 * so a bad payload can never crash the server or 4xx/5xx the exporter.
 */
function otlpBodyParser(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      req.body = undefined;
      next();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      let buf = Buffer.concat(chunks);
      const gzipHeader = (req.headers['content-encoding'] ?? '')
        .toString()
        .toLowerCase()
        .includes('gzip');
      const gzipMagic = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      if (gzipHeader || gzipMagic) {
        buf = gunzipSync(buf);
      }
      req.body = buf.length ? (JSON.parse(buf.toString()) as unknown) : undefined;
    } catch {
      req.body = undefined;
    }
    next();
  });
  req.on('error', () => {
    if (aborted) return;
    aborted = true;
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
