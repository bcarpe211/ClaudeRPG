import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RunProvider, UsageCountersV1 } from './run-events';

const safeNonNegativeInteger = z.number().finite().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const usageWeightsSchema = z.object({
  input: z.literal(1),
  output: z.literal(1),
  cache_read: z.literal(0),
  cache_write: z.literal(1),
  reasoning_output: z.literal(1),
}).strict();

const raidPowerPolicyV1Schema = z.object({
  policy_version: z.literal(1),
  enabled_providers: z.tuple([z.literal('codex')]),
  usage_weights: usageWeightsSchema,
  provider_multipliers: z.object({
    codex: z.literal(1),
  }).strict(),
  completion_credit: safeNonNegativeInteger,
  duration: z.object({
    scale: z.number().finite().positive(),
    cap: safeNonNegativeInteger,
  }).strict(),
}).strict();

export interface RaidPowerPolicy {
  readonly policy_version: number;
  readonly enabled_providers: readonly string[];
  readonly usage_weights: Readonly<Record<keyof UsageCountersV1, number>>;
  readonly provider_multipliers: Readonly<Record<string, number>>;
  readonly completion_credit: number;
  readonly duration: Readonly<{
    scale: number;
    cap: number;
  }>;
}

export interface RaidPowerPolicyV1 extends RaidPowerPolicy {
  readonly policy_version: 1;
  readonly enabled_providers: readonly ['codex'];
  readonly provider_multipliers: Readonly<{ codex: 1 }>;
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}

export function loadRaidPowerPolicy(path: string): RaidPowerPolicyV1 {
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return deepFreeze(raidPowerPolicyV1Schema.parse(document));
}

function safeCounter(value: number, category: keyof UsageCountersV1): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`usage counter ${category} must be a non-negative safe integer`);
  }
  return value;
}

export function usageCredit(
  policy: RaidPowerPolicy,
  provider: RunProvider,
  cumulative: UsageCountersV1,
): number {
  const multiplier = policy.provider_multipliers[provider];
  if ((policy.policy_version === 1 && provider !== 'codex')
    || !policy.enabled_providers.includes(provider)
    || !Number.isFinite(multiplier)
    || multiplier <= 0) {
    throw new Error(
      `provider ${provider} is not enabled by Raid Power policy v${policy.policy_version}`,
    );
  }

  let weightedUsage = 0;
  for (const category of Object.keys(policy.usage_weights) as Array<keyof UsageCountersV1>) {
    const contribution = safeCounter(cumulative[category], category)
      * policy.usage_weights[category];
    if (!Number.isSafeInteger(contribution)
      || !Number.isSafeInteger(weightedUsage + contribution)) {
      throw new RangeError('weighted cumulative usage exceeds the safe integer range');
    }
    weightedUsage += contribution;
  }

  const targetCredit = Math.round(weightedUsage * multiplier);
  if (!Number.isSafeInteger(targetCredit) || targetCredit < 0) {
    throw new RangeError('cumulative usage credit exceeds the safe integer range');
  }
  return targetCredit;
}

export function durationCredit(policy: RaidPowerPolicy, durationMs: number): number {
  if (!Number.isFinite(durationMs)) {
    throw new RangeError('durationMs must be finite');
  }
  const minutes = Math.max(0, durationMs) / 60_000;
  return Math.min(
    policy.duration.cap,
    Math.round(policy.duration.scale * Math.sqrt(minutes)),
  );
}
