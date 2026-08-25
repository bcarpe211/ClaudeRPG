import type {
  RaidPowerPolicy,
  RaidPowerPolicyV1,
  RaidPowerPolicyV2,
} from './raid-power-policy';

export interface RaidPowerPolicySchedule {
  readonly runCutoverAt: number;
  readonly v2CutoverAt: number;
  readonly v1: RaidPowerPolicyV1;
  readonly v2: RaidPowerPolicyV2;
}

function safeEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer epoch`);
  }
}

export function createRaidPowerPolicySchedule(
  v1: RaidPowerPolicyV1,
  v2: RaidPowerPolicyV2,
  runCutoverAt: number,
  v2CutoverAt: number,
): RaidPowerPolicySchedule {
  safeEpoch(runCutoverAt, 'runCutoverAt');
  safeEpoch(v2CutoverAt, 'v2CutoverAt');
  if (v2CutoverAt < runCutoverAt) {
    throw new RangeError('v2CutoverAt must not be earlier than runCutoverAt');
  }
  return Object.freeze({ runCutoverAt, v2CutoverAt, v1, v2 });
}

export function policyForRunStart(
  schedule: RaidPowerPolicySchedule,
  startedAtMs: number,
): RaidPowerPolicy | null {
  if (startedAtMs < schedule.runCutoverAt) return null;
  return startedAtMs < schedule.v2CutoverAt ? schedule.v1 : schedule.v2;
}
