import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { getPlayerByToken } from '../../domain/players';
import {
  authenticateDevice,
  createEnrollment,
  exchangeEnrollment,
  type AuthenticatedDevice,
} from '../../domain/raider-enrollment';
import {
  parseRunEventBatch,
  providerForSurface,
  type RunProvider,
  type RunSurface,
} from '../../domain/run-events';
import { ingestRunEvents } from '../../domain/run-ingest';
import { loadRaidPowerPolicy } from '../../domain/raid-power-policy';
import {
  createRunRateLimiter,
  type RunRateLimitScope,
} from '../run-rate-limit';

const MAX_BODY_BYTES = 256 * 1_024;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KNOWN_PROVIDERS = new Set<RunProvider>(['codex', 'claude', 'omp']);
const KNOWN_SURFACES = new Set<RunSurface>([
  'codex_desktop',
  'codex_cli',
  'claude_code',
  'omp',
]);
const rawBodyBytes = new WeakMap<Request, number>();
const rawBodyRejected = new WeakSet<Request>();

type DestroyableWritable = NodeJS.WritableStream & {
  destroy(error?: Error): void;
};

const raiderKeyBody = z.object({
  raider_key: z.string().min(1).max(200),
}).strict();

const enrollmentBody = z.object({
  code: z.string().regex(CREDENTIAL_PATTERN),
  device_id: z.string().uuid(),
  companion_version: z.string().min(1).max(100),
}).strict();

const heartbeatBody = z.object({
  companion_version: z.string().min(1).max(100),
}).strict();

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function strictJson(req: Request, res: Response, next: NextFunction): void {
  if (req.is('application/json') !== 'application/json') {
    res.status(415).json({ reason: 'unsupported_media_type' });
    return;
  }
  next();
}

function rejectPayloadTooLarge(
  req: Request,
  res: Response,
  downstreamStreams: ReadonlySet<DestroyableWritable> = new Set(),
): void {
  if (rawBodyRejected.has(req)) return;
  rawBodyRejected.add(req);
  req.pause();
  req.unpipe();
  res.set('Connection', 'close');
  res.once('finish', () => {
    if (!req.destroyed) req.destroy();
  });
  res.status(413).json({ reason: 'payload_too_large' });
  for (const stream of downstreamStreams) {
    stream.destroy(new Error('raw request body exceeds 256 KiB'));
  }
}

function boundedWireBody(req: Request, res: Response, next: NextFunction): void {
  const contentLength = req.get('content-length');
  if (contentLength !== undefined) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }
    if (bytes > MAX_BODY_BYTES) {
      rejectPayloadTooLarge(req, res);
      return;
    }
  }
  next();
}

function trackWireBody(req: Request, res: Response, next: NextFunction): void {
  rawBodyBytes.set(req, 0);
  const downstreamStreams = new Set<DestroyableWritable>();
  const originalPipe = req.pipe.bind(req);
  req.pipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) => {
    if ('destroy' in destination && typeof destination.destroy === 'function') {
      downstreamStreams.add(destination as DestroyableWritable);
    }
    return originalPipe(destination, options);
  }) as typeof req.pipe;
  req.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    const total = (rawBodyBytes.get(req) ?? 0) + bytes;
    rawBodyBytes.set(req, total);
    if (total > MAX_BODY_BYTES) {
      rejectPayloadTooLarge(req, res, downstreamStreams);
    }
  });
  next();
}

function rejectOversizedWireBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if ((rawBodyBytes.get(req) ?? 0) > MAX_BODY_BYTES) {
    if (!res.headersSent) rejectPayloadTooLarge(req, res);
    return;
  }
  next();
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '');
  return match?.[1] ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hasDisabledSurface(
  input: unknown,
  enabledSurfaces: ReadonlySet<RunSurface>,
): boolean {
  if (input === null || typeof input !== 'object') return false;
  const events = (input as { events?: unknown }).events;
  if (!Array.isArray(events)) return false;

  return events.some((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return false;
    const { provider, surface } = candidate as {
      provider?: unknown;
      surface?: unknown;
    };
    if (typeof surface !== 'string' || !KNOWN_SURFACES.has(surface as RunSurface)) {
      return false;
    }
    const typedSurface = surface as RunSurface;
    if (!enabledSurfaces.has(typedSurface)) return true;
    return typeof provider === 'string'
      && KNOWN_PROVIDERS.has(provider as RunProvider)
      && providerForSurface(typedSurface) !== provider;
  });
}

export function registerRunRoutes(app: Express, { db, config }: AppDeps): void {
  const router = express.Router();
  const parseJson = [
    strictJson,
    boundedWireBody,
    trackWireBody,
    express.json({ limit: '256kb' }),
    rejectOversizedWireBody,
  ];
  const rateLimiter = createRunRateLimiter();
  const policy = config.scoringMode === 'runtime-raiders'
    ? loadRaidPowerPolicy(config.raidPowerPolicyPath)
    : null;
  const enabledSurfaces = new Set(config.enabledRunSurfaces);

  const applyRateLimit = (
    req: Request,
    res: Response,
    scope: RunRateLimitScope,
    client: string,
  ): boolean => {
    const decision = rateLimiter.check(scope, client, Date.now());
    if (decision.allowed) return true;
    res.set('Retry-After', String(decision.retryAfterSeconds));
    res.status(429).json({ reason: 'rate_limited' });
    return false;
  };

  const authenticate = (
    req: Request,
    res: Response,
    unauthenticatedScope: RunRateLimitScope,
    deviceScope: RunRateLimitScope,
  ): AuthenticatedDevice | null => {
    const token = bearerToken(req);
    const device = token === null ? null : authenticateDevice(db, token, Date.now());
    if (!device) {
      if (!applyRateLimit(req, res, unauthenticatedScope, clientIp(req))) return null;
      res.status(401).json({ reason: 'unauthorized' });
      return null;
    }
    if (!applyRateLimit(req, res, deviceScope, device.deviceId)) return null;
    return device;
  };

  const requireRuntimeScoring = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (config.scoringMode !== 'runtime-raiders' || policy === null) {
      res.status(503).json({ reason: 'scoring_disabled' });
      return;
    }
    next();
  };

  router.post('/raiders/enrollments', ...parseJson, (req, res) => {
    if (!applyRateLimit(req, res, 'enrollment-create', clientIp(req))) return;
    const parsed = raiderKeyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }
    const player = getPlayerByToken(db, parsed.data.raider_key);
    if (!player) {
      res.status(401).json({ reason: 'invalid_raider' });
      return;
    }
    const enrollment = createEnrollment(db, player.id, Date.now());
    const installUrl = `${config.publicUrl}/install.sh`;
    res.status(201).json({
      install_command: `curl -fsSL ${shellQuote(installUrl)} | sh -s -- --code ${shellQuote(enrollment.code)}`,
      expires_at: enrollment.expiresAt,
    });
  });

  router.post('/raiders/enroll', ...parseJson, (req, res) => {
    if (!applyRateLimit(req, res, 'enrollment-exchange', clientIp(req))) return;
    const parsed = enrollmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }
    const exchanged = exchangeEnrollment(
      db,
      parsed.data.code,
      parsed.data.device_id,
      parsed.data.companion_version,
      Date.now(),
    );
    if (!exchanged) {
      res.status(401).json({ reason: 'invalid_enrollment' });
      return;
    }
    res.status(201).json({
      device_token: exchanged.deviceToken,
      dedupe_secret: exchanged.dedupeSecret,
      server_url: config.publicUrl,
      cutover_at: config.runCutoverAt,
      enabled_surfaces: config.enabledRunSurfaces,
    });
  });

  router.post('/runs/events', requireRuntimeScoring, ...parseJson, (req, res) => {
    const device = authenticate(
      req,
      res,
      'unauthenticated-events',
      'device-events',
    );
    if (!device) return;

    if (hasDisabledSurface(req.body, enabledSurfaces)) {
      res.status(422).json({ reason: 'surface_disabled' });
      return;
    }

    const parsed = (() => {
      try {
        return parseRunEventBatch(req.body, Date.now());
      } catch {
        return null;
      }
    })();
    if (parsed === null) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }

    const result = ingestRunEvents(
      db,
      device,
      parsed,
      policy!,
      config.runCutoverAt,
      Date.now(),
    );
    res.status(200).json(result);
  });

  router.post('/runs/heartbeat', ...parseJson, (req, res) => {
    const parsed = heartbeatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }
    const device = authenticate(
      req,
      res,
      'unauthenticated-heartbeat',
      'device-heartbeat',
    );
    if (!device) return;

    db.prepare(`
      UPDATE raider_devices SET companion_version = ? WHERE device_id = ?
    `).run(parsed.data.companion_version, device.deviceId);
    res.status(204).end();
  });

  const privateRouteErrors: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) return;
    if ((rawBodyBytes.get(req) ?? 0) > MAX_BODY_BYTES) {
      rejectPayloadTooLarge(req, res);
      return;
    }
    const status = typeof error === 'object' && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 413) {
      res.status(413).json({ reason: 'payload_too_large' });
      return;
    }
    if (status === 415) {
      res.status(415).json({ reason: 'unsupported_media_type' });
      return;
    }
    if (status === 400 || error instanceof SyntaxError) {
      res.status(400).json({ reason: 'invalid_request' });
      return;
    }
    res.status(500).json({ reason: 'internal_error' });
  };
  router.use(privateRouteErrors);
  app.use('/api', router);
}
