import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadRaidPowerPolicy,
  loadRaidPowerPolicyV2,
} from '../src/domain/raid-power-policy';
import {
  createRaidPowerPolicySchedule,
  policyForRunStart,
} from '../src/domain/raid-power-policy-schedule';

const RUN_CUTOVER = 1_800_000_000_000;
const V2_CUTOVER = 1_800_000_100_000;

function schedule() {
  const v1 = loadRaidPowerPolicy(resolve('config/raid-power-policy-v1.json'));
  const v2 = loadRaidPowerPolicyV2(resolve('config/raid-power-policy-v2.json'));
  return {
    v1,
    v2,
    schedule: createRaidPowerPolicySchedule(v1, v2, RUN_CUTOVER, V2_CUTOVER),
  };
}

describe('Raid Power policy schedule', () => {
  it('selects an immutable policy from the Run start-time boundaries', () => {
    const { v1, v2, schedule: policySchedule } = schedule();

    expect(policyForRunStart(policySchedule, RUN_CUTOVER - 1)).toBeNull();
    expect(policyForRunStart(policySchedule, RUN_CUTOVER)).toBe(v1);
    expect(policyForRunStart(policySchedule, V2_CUTOVER - 1)).toBe(v1);
    expect(policyForRunStart(policySchedule, V2_CUTOVER)).toBe(v2);
    expect(Object.isFrozen(policySchedule)).toBe(true);
  });

  it.each([
    [-1, V2_CUTOVER],
    [Number.NaN, V2_CUTOVER],
    [Number.POSITIVE_INFINITY, V2_CUTOVER],
    [Number.MAX_SAFE_INTEGER + 1, V2_CUTOVER],
    [RUN_CUTOVER, -1],
    [RUN_CUTOVER, Number.NaN],
    [RUN_CUTOVER, Number.POSITIVE_INFINITY],
    [RUN_CUTOVER, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects non-safe cutover epochs %s and %s', (runCutoverAt, v2CutoverAt) => {
    const v1 = loadRaidPowerPolicy(resolve('config/raid-power-policy-v1.json'));
    const v2 = loadRaidPowerPolicyV2(resolve('config/raid-power-policy-v2.json'));

    expect(() => createRaidPowerPolicySchedule(v1, v2, runCutoverAt, v2CutoverAt))
      .toThrow(RangeError);
  });

  it('rejects a v2 cutover before the first accepted Run', () => {
    const v1 = loadRaidPowerPolicy(resolve('config/raid-power-policy-v1.json'));
    const v2 = loadRaidPowerPolicyV2(resolve('config/raid-power-policy-v2.json'));

    expect(() => createRaidPowerPolicySchedule(v1, v2, RUN_CUTOVER, RUN_CUTOVER - 1))
      .toThrow(/v2CutoverAt.*runCutoverAt/i);
  });
});
