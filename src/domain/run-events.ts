import { z } from 'zod';

const MAX_EVENTS_PER_BATCH = 100;
const MAX_FIELD_LENGTH = 100;
const MAX_RUN_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export type RunProvider = 'codex' | 'claude' | 'omp';
export type RunSurface = 'codex_desktop' | 'codex_cli' | 'claude_code' | 'omp';

export interface UsageCountersV1 {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning_output: number;
}

export interface RunEventV1 {
  schema_version: 1;
  companion_version: string;
  device_id: string;
  provider: RunProvider;
  surface: RunSurface;
  run_key: string;
  sequence: number;
  event_time_ms: number;
  observed_at_ms: number;
  started_at_ms: number;
  state: 'open' | 'completed' | 'failed' | 'cancelled';
  usage: UsageCountersV1;
  model: string | null;
  effort: string | null;
  idempotency_key: string;
}

const safeNonNegativeInteger = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lowerHexKey = z.string().regex(/^[0-9a-f]{64}$/);

const usageCountersSchema = z.object({
  input: safeNonNegativeInteger,
  output: safeNonNegativeInteger,
  cache_read: safeNonNegativeInteger,
  cache_write: safeNonNegativeInteger,
  reasoning_output: safeNonNegativeInteger,
}).strict();

const runEventSchema = z.object({
  schema_version: z.literal(1),
  companion_version: z.string().min(1).max(MAX_FIELD_LENGTH),
  device_id: z.string().uuid(),
  provider: z.enum(['codex', 'claude', 'omp']),
  surface: z.enum(['codex_desktop', 'codex_cli', 'claude_code', 'omp']),
  run_key: lowerHexKey,
  sequence: safeNonNegativeInteger,
  event_time_ms: safeNonNegativeInteger,
  observed_at_ms: safeNonNegativeInteger,
  started_at_ms: safeNonNegativeInteger,
  state: z.enum(['open', 'completed', 'failed', 'cancelled']),
  usage: usageCountersSchema,
  model: z.string().max(MAX_FIELD_LENGTH).nullable(),
  effort: z.string().max(MAX_FIELD_LENGTH).nullable(),
  idempotency_key: lowerHexKey,
}).strict().superRefine((event, context) => {
  if (providerForSurface(event.surface) !== event.provider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider must match surface',
      path: ['provider'],
    });
  }
  if (event.event_time_ms < event.started_at_ms
    || event.event_time_ms - event.started_at_ms > MAX_RUN_DURATION_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'run duration must be between zero and seven days',
      path: ['event_time_ms'],
    });
  }
  if (event.observed_at_ms < event.event_time_ms) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'observed_at_ms must not predate event_time_ms',
      path: ['observed_at_ms'],
    });
  }
});

const runEventBatchSchema = z.object({
  events: z.array(runEventSchema).max(MAX_EVENTS_PER_BATCH),
}).strict();

const providerBySurface: Record<RunSurface, RunProvider> = {
  codex_desktop: 'codex',
  codex_cli: 'codex',
  claude_code: 'claude',
  omp: 'omp',
};

export function providerForSurface(surface: RunSurface): RunProvider {
  return providerBySurface[surface];
}

export function parseRunEventBatch(input: unknown, now: number): RunEventV1[] {
  const receivedAt = safeNonNegativeInteger.parse(now);
  const batch = runEventBatchSchema.parse(input);

  for (const event of batch.events) {
    for (const timestamp of [event.event_time_ms, event.observed_at_ms, event.started_at_ms]) {
      if (Math.abs(timestamp - receivedAt) > MAX_RUN_DURATION_MS) {
        throw new z.ZodError([{
          code: z.ZodIssueCode.custom,
          message: 'timestamps must be within seven days of receipt',
          path: ['events', 'timestamps'],
        }]);
      }
    }
  }

  return batch.events;
}
