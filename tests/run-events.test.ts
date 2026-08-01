import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseRunEventBatch,
  providerForSurface,
  type RunEventV1,
} from '../src/domain/run-events';

const receivedAt = 1_800_000_000_001;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;

function validEvent(): RunEventV1 {
  return {
    schema_version: 1,
    companion_version: '0.1.0',
    device_id: randomUUID(),
    provider: 'codex',
    surface: 'codex_desktop',
    run_key: 'a'.repeat(64),
    sequence: 1,
    event_time_ms: receivedAt - 1,
    observed_at_ms: receivedAt,
    started_at_ms: receivedAt - 5_000,
    state: 'open',
    usage: {
      input: 10,
      output: 2,
      cache_read: 0,
      cache_write: 0,
      reasoning_output: 0,
    },
    model: 'gpt-test',
    effort: 'high',
    idempotency_key: 'b'.repeat(64),
  };
}

describe('Run event v1 contract', () => {
  it('accepts one complete allowlisted Codex event', () => {
    const event = validEvent();

    expect(parseRunEventBatch({ events: [event] }, receivedAt)).toEqual([event]);
  });

  it('rejects content-bearing and unknown fields at every boundary', () => {
    const event = validEvent();

    expect(() => parseRunEventBatch({ events: [{ ...event, prompt: 'DO_NOT_EXPORT' }] }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({ events: [event], upload_metadata: 'not allowlisted' }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, usage: { ...event.usage, provider_total: 12 } }],
    }, receivedAt)).toThrow();
  });

  it('enforces bounded batches, fields, counters, duration, and receipt window', () => {
    const event = validEvent();

    expect(() => parseRunEventBatch({ events: Array.from({ length: 101 }, () => event) }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({ events: [{ ...event, run_key: 'A'.repeat(64) }] }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({ events: [{ ...event, idempotency_key: 'b'.repeat(63) }] }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, usage: { ...event.usage, input: Number.MAX_SAFE_INTEGER + 1 } }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, usage: { ...event.usage, output: -1 } }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, started_at_ms: event.event_time_ms - sevenDaysMs - 1 }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, event_time_ms: receivedAt - sevenDaysMs - 1 }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({ events: [{ ...event, model: 'm'.repeat(101) }] }, receivedAt))
      .toThrow();
  });

  it('maps every declared surface to its canonical provider', () => {
    expect(providerForSurface('codex_desktop')).toBe('codex');
    expect(providerForSurface('codex_cli')).toBe('codex');
    expect(providerForSurface('claude_code')).toBe('claude');
    expect(providerForSurface('omp')).toBe('omp');
  });
});
