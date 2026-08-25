import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  durationCredit,
  type RaidPowerPolicy,
  type RaidPowerPolicyV1,
} from '../../src/domain/raid-power-policy';
import type { UsageCountersV1 } from '../../src/domain/run-events';

export const CALIBRATION_WORKLOADS = [
  'short_explanation',
  'small_code_edit',
  'medium_repository_task',
  'long_reverse_engineering_analysis',
] as const;

export const CALIBRATION_SURFACES = ['codex_desktop', 'codex_cli'] as const;

export type CalibrationWorkload = typeof CALIBRATION_WORKLOADS[number];
export type CalibrationSurface = typeof CALIBRATION_SURFACES[number];

export interface CalibrationSample {
  provider: 'codex';
  surface: CalibrationSurface;
  workload: CalibrationWorkload;
  usage: UsageCountersV1;
  duration_ms: number;
}

export interface CalibrationRow {
  workload: CalibrationWorkload;
  surface: CalibrationSurface;
  sample_count: number;
  median_weighted_usage: number;
  median_duration_ms: number;
  median_raid_power: number;
}

export interface CalibrationComparison {
  workload: CalibrationWorkload;
  desktop_median_raid_power: number;
  cli_median_raid_power: number;
  difference_percent: number;
  within_25_percent: boolean;
}

export interface CalibrationResult {
  policy: RaidPowerPolicy;
  baseline: number;
  rows: CalibrationRow[];
  comparisons: CalibrationComparison[];
}

const safeNonNegativeInteger = z.number().finite().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const usageSchema = z.object({
  input: safeNonNegativeInteger,
  output: safeNonNegativeInteger,
  cache_read: safeNonNegativeInteger,
  cache_write: safeNonNegativeInteger,
  reasoning_output: safeNonNegativeInteger,
}).strict();

const sampleSchema = z.object({
  provider: z.literal('codex'),
  surface: z.enum(CALIBRATION_SURFACES),
  workload: z.enum(CALIBRATION_WORKLOADS),
  usage: usageSchema,
  duration_ms: safeNonNegativeInteger,
}).strict();

const samplesDocumentSchema = z.object({
  schema_version: z.literal(1),
  samples: z.array(sampleSchema),
}).strict();

const usageWeights: RaidPowerPolicyV1['usage_weights'] = {
  input: 1,
  output: 1,
  cache_read: 0,
  cache_write: 1,
  reasoning_output: 1,
};

export function parseCalibrationSamples(input: unknown): CalibrationSample[] {
  return samplesDocumentSchema.parse(input).samples;
}

function weightedUsage(sample: CalibrationSample): number {
  let total = 0;
  for (const category of Object.keys(usageWeights) as Array<keyof UsageCountersV1>) {
    const contribution = sample.usage[category] * usageWeights[category];
    if (!Number.isSafeInteger(contribution) || !Number.isSafeInteger(total + contribution)) {
      throw new RangeError('calibration weighted usage exceeds the safe integer range');
    }
    total += contribution;
  }
  return total;
}

function checkedSafeIntegerSum(values: readonly number[], message: string): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) {
      throw new RangeError(message);
    }
    total += value;
  }
  return total;
}

function safeIntegerMidpoint(lower: number, upper: number): number {
  if (!Number.isSafeInteger(lower)
    || !Number.isSafeInteger(upper)
    || lower < 0
    || upper < lower) {
    throw new RangeError('calibration median sum exceeds the safe integer range');
  }

  const delta = upper - lower;
  if (delta % 2 === 0) {
    return lower + delta / 2;
  }

  const integerPart = lower + (delta - 1) / 2;
  if (integerPart > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new RangeError('calibration median sum exceeds the safe integer range');
  }
  return integerPart + 0.5;
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error('cannot compute a median without samples');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];

  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (Number.isSafeInteger(lower) && Number.isSafeInteger(upper)) {
    return safeIntegerMidpoint(lower, upper);
  }

  const doubledLower = lower * 2;
  const doubledUpper = upper * 2;
  return safeIntegerMidpoint(doubledLower, doubledUpper) / 2;
}

function sampleTotal(policy: RaidPowerPolicy, sample: CalibrationSample): number {
  return checkedSafeIntegerSum(
    [
      weightedUsage(sample),
      policy.completion_credit,
      durationCredit(policy, sample.duration_ms),
    ],
    'calibration sample total exceeds the safe integer range',
  );
}

export function generateCalibration(samples: readonly CalibrationSample[]): CalibrationResult {
  const buckets = new Map<string, CalibrationSample[]>();
  for (const workload of CALIBRATION_WORKLOADS) {
    for (const surface of CALIBRATION_SURFACES) {
      buckets.set(`${workload}/${surface}`, []);
    }
  }

  for (const rawSample of samples) {
    const sample = sampleSchema.parse(rawSample);
    buckets.get(`${sample.workload}/${sample.surface}`)!.push(sample);
  }

  for (const workload of CALIBRATION_WORKLOADS) {
    for (const surface of CALIBRATION_SURFACES) {
      const count = buckets.get(`${workload}/${surface}`)!.length;
      if (count < 3) {
        throw new Error(`${workload}/${surface} requires at least 3 samples; found ${count}`);
      }
    }
  }

  const workloadMedians = CALIBRATION_WORKLOADS.map((workload) => median(
    CALIBRATION_SURFACES.flatMap((surface) => (
      buckets.get(`${workload}/${surface}`)!.map(weightedUsage)
    )),
  ));
  const baseline = median(workloadMedians);
  const completionCredit = Math.max(1, Math.round(baseline * 0.02));
  const policy: RaidPowerPolicy = {
    policy_version: 1,
    enabled_providers: ['codex'],
    usage_weights: usageWeights,
    provider_multipliers: { codex: 1.0 },
    completion_credit: completionCredit,
    duration: {
      scale: completionCredit / Math.sqrt(10),
      cap: completionCredit * 4,
    },
  };

  const rows: CalibrationRow[] = CALIBRATION_WORKLOADS.flatMap((workload) => (
    CALIBRATION_SURFACES.map((surface) => {
      const bucket = buckets.get(`${workload}/${surface}`)!;
      return {
        workload,
        surface,
        sample_count: bucket.length,
        median_weighted_usage: median(bucket.map(weightedUsage)),
        median_duration_ms: median(bucket.map((sample) => sample.duration_ms)),
        median_raid_power: median(bucket.map((sample) => sampleTotal(policy, sample))),
      };
    })
  ));

  const comparisons: CalibrationComparison[] = CALIBRATION_WORKLOADS.map((workload) => {
    const desktop = rows.find((row) => (
      row.workload === workload && row.surface === 'codex_desktop'
    ))!.median_raid_power;
    const cli = rows.find((row) => (
      row.workload === workload && row.surface === 'codex_cli'
    ))!.median_raid_power;
    const denominator = Math.max(desktop, cli);
    const differencePercent = denominator === 0 ? 0 : Math.abs(desktop - cli) / denominator * 100;
    return {
      workload,
      desktop_median_raid_power: desktop,
      cli_median_raid_power: cli,
      difference_percent: differencePercent,
      within_25_percent: differencePercent <= 25,
    };
  });

  return { policy, baseline, rows, comparisons };
}

function displayWorkload(workload: CalibrationWorkload): string {
  return workload.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function displaySurface(surface: CalibrationSurface): string {
  return surface === 'codex_desktop' ? 'Codex Desktop' : 'Codex CLI';
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function renderCalibrationReport(calibration: CalibrationResult): string {
  const sampleRows = calibration.rows.map((row) => (
    `| ${displayWorkload(row.workload)} | ${displaySurface(row.surface)} | ${row.sample_count} | ${formatNumber(row.median_weighted_usage)} | ${formatNumber(row.median_duration_ms)} | ${formatNumber(row.median_raid_power)} |`
  ));
  const comparisonRows = calibration.comparisons.map((comparison) => (
    `| ${displayWorkload(comparison.workload)} | ${formatNumber(comparison.desktop_median_raid_power)} | ${formatNumber(comparison.cli_median_raid_power)} | ${comparison.difference_percent.toFixed(2)}% | ${comparison.within_25_percent ? 'PASS' : 'FAIL'} |`
  ));

  return [
    '# Raid Power scoring calibration v1',
    '',
    `Overall baseline weighted usage: ${formatNumber(calibration.baseline)}`,
    '',
    '| Workload | Surface | Samples | Median weighted usage | Median duration ms | Median Raid Power |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...sampleRows,
    '',
    '## Surface review',
    '',
    '| Workload | Desktop median Raid Power | CLI median Raid Power | Difference | Review |',
    '| --- | ---: | ---: | ---: | --- |',
    ...comparisonRows,
    '',
    'Cross-provider comparison is inapplicable to v1.',
    'Enabling Omp or Claude Code requires a new immutable policy version and a separate matched-provider calibration review; v1 must not be edited.',
    '',
  ].join('\n');
}

function policyJson(policy: RaidPowerPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export function writeCalibrationArtifacts(
  samplesPath: string,
  policyPath: string,
  reportPath: string,
): void {
  const input: unknown = JSON.parse(readFileSync(samplesPath, 'utf8'));
  const calibration = generateCalibration(parseCalibrationSamples(input));
  const failed = calibration.comparisons.filter((comparison) => !comparison.within_25_percent);
  if (failed.length > 0) {
    throw new Error(`surface median difference exceeds 25% for: ${failed.map((entry) => entry.workload).join(', ')}`);
  }
  writeFileSync(policyPath, policyJson(calibration.policy));
  writeFileSync(reportPath, renderCalibrationReport(calibration));
}

function runCli(): void {
  const [, , samplesPath, policyPath, reportPath] = process.argv;
  if (!samplesPath || !policyPath || !reportPath || process.argv.length !== 5) {
    throw new Error(
      'usage: tsx tools/runtime-raiders/calibrate-scoring.ts <samples.json> <policy.json> <report.md>',
    );
  }
  writeCalibrationArtifacts(samplesPath, policyPath, reportPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
