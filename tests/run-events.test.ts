import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseRunEventBatch,
  providerForSurface,
  type RunEventV1,
  type RunProvider,
  type RunSurface,
} from '../src/domain/run-events';

const receivedAt = 1_800_000_000_001;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
const canonicalPairs: ReadonlyArray<readonly [RunSurface, RunProvider]> = [
  ['codex_desktop', 'codex'],
  ['codex_cli', 'codex'],
  ['claude_code', 'claude'],
  ['omp', 'omp'],
];

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
    expect(() => parseRunEventBatch({
      events: [{
        ...event,
        event_time_ms: receivedAt + sevenDaysMs + 1,
        started_at_ms: receivedAt + sevenDaysMs,
      }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({
      events: [{ ...event, observed_at_ms: receivedAt + sevenDaysMs + 1 }],
    }, receivedAt)).toThrow();
    expect(() => parseRunEventBatch({ events: [{ ...event, model: 'm'.repeat(101) }] }, receivedAt))
      .toThrow();
    expect(() => parseRunEventBatch({ events: [{ ...event, effort: 'e'.repeat(101) }] }, receivedAt))
      .toThrow();
  });

  it('accepts a maximum-sized batch and nullable model metadata', () => {
    const event = validEvent();
    const events = Array.from({ length: 100 }, (_, sequence) => ({
      ...event,
      sequence,
      model: null,
      effort: null,
    }));

    expect(parseRunEventBatch({ events }, receivedAt)).toHaveLength(100);
  });

  it.each(['open', 'completed', 'failed', 'cancelled'] as const)(
    'accepts the %s state',
    (state) => {
      expect(parseRunEventBatch({ events: [{ ...validEvent(), state }] }, receivedAt)).toHaveLength(1);
    },
  );

  it.each([
    ['provider', 'openai'],
    ['surface', 'web'],
    ['state', 'paused'],
  ])('rejects an unknown %s enum value', (field, value) => {
    expect(() => parseRunEventBatch({
      events: [{ ...validEvent(), [field]: value }],
    }, receivedAt)).toThrow();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid sequence of %s',
    (sequence) => {
      expect(() => parseRunEventBatch({ events: [{ ...validEvent(), sequence }] }, receivedAt))
        .toThrow();
    },
  );

  it('rejects an observation that predates its event', () => {
    const event = validEvent();

    expect(() => parseRunEventBatch({
      events: [{ ...event, observed_at_ms: event.event_time_ms - 1 }],
    }, receivedAt)).toThrow();
  });

  describe.each(canonicalPairs)('surface %s with provider %s', (surface, provider) => {
    it('is accepted by the parser', () => {
      expect(parseRunEventBatch({
        events: [{ ...validEvent(), surface, provider }],
      }, receivedAt)).toHaveLength(1);
    });

    it('is returned by the canonical mapping helper', () => {
      expect(providerForSurface(surface)).toBe(provider);
    });
  });

  it.each([
    ['claude', 'codex_desktop'],
    ['codex', 'claude_code'],
  ] as const)('rejects mismatched provider %s and surface %s', (provider, surface) => {
    expect(() => parseRunEventBatch({
      events: [{ ...validEvent(), provider, surface }],
    }, receivedAt)).toThrow();
  });
});
