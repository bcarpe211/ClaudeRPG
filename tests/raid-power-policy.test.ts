import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  durationCredit,
  loadRaidPowerPolicy,
  usageCredit,
  type RaidPowerPolicy,
} from '../src/domain/raid-power-policy';
import {
  generateCalibration,
  parseCalibrationSamples,
  renderCalibrationReport,
  writeCalibrationArtifacts,
  type CalibrationSample,
  type CalibrationWorkload,
} from '../tools/runtime-raiders/calibrate-scoring';

const usage = {
  input: 10,
  output: 20,
  cache_read: 30,
  cache_write: 40,
  reasoning_output: 50,
};

function policyDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_version: 1,
    enabled_providers: ['codex'],
    usage_weights: {
      input: 1,
      output: 1,
      cache_read: 0,
      cache_write: 1,
      reasoning_output: 1,
    },
    provider_multipliers: { codex: 1.0 },
    completion_credit: 5,
    duration: { scale: 2, cap: 20 },
    ...overrides,
  };
}

function loadDocument(document: unknown): RaidPowerPolicy {
  const directory = mkdtempSync(join(tmpdir(), 'raid-power-policy-'));
  const path = join(directory, 'policy.json');
  writeFileSync(path, `${JSON.stringify(document)}\n`);
  return loadRaidPowerPolicy(path);
}

const workloads: CalibrationWorkload[] = [
  'short_explanation',
  'small_code_edit',
  'medium_repository_task',
  'long_reverse_engineering_analysis',
];

function completeSamples(): CalibrationSample[] {
  return workloads.flatMap((workload, workloadIndex) => (
    (['codex_desktop', 'codex_cli'] as const).flatMap((surface) => (
      [0, 1, 2].map((offset) => ({
        provider: 'codex' as const,
        surface,
        workload,
        usage: {
          input: (workloadIndex + 1) * 100 + offset,
          output: 0,
          cache_read: 10_000,
          cache_write: 0,
          reasoning_output: 0,
        },
        duration_ms: 60_000,
      }))
    ))
  ));
}

describe('Raid Power policy v1', () => {
  it('loads the exact Codex-only v1 schema as a deeply immutable value', () => {
    const policy = loadDocument(policyDocument());

    expect(policy.provider_multipliers).toEqual({ codex: 1.0 });
    expect(policy.enabled_providers).toEqual(['codex']);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.usage_weights)).toBe(true);
    expect(Object.isFrozen(policy.provider_multipliers)).toBe(true);
    expect(Object.isFrozen(policy.duration)).toBe(true);
    expect(() => {
      (policy.duration as { cap: number }).cap = 999;
    }).toThrow(TypeError);
    expect(policy.duration.cap).toBe(20);
  });

  it.each([
    policyDocument({ provider_multipliers: { codex: 1, claude: 1 } }),
    policyDocument({ provider_multipliers: { codex: 1, omp: 1 } }),
    policyDocument({ provider_multipliers: { codex: 0.9 } }),
    policyDocument({ enabled_providers: ['codex', 'claude'] }),
    policyDocument({ policy_version: 2 }),
    policyDocument({ completion_credit: -1 }),
    policyDocument({ duration: { scale: 0, cap: 20 } }),
    policyDocument({ usage_weights: { ...policyDocument().usage_weights as object, cache_read: 1 } }),
    { ...policyDocument(), model_multipliers: { test: 2 } },
    { ...policyDocument(), effort_multipliers: { high: 2 } },
  ])('rejects a policy that differs from immutable v1', (document) => {
    expect(() => loadDocument(document)).toThrow();
  });

  it('scores cumulative target usage monotonically and excludes cache reads', () => {
    const policy = loadDocument(policyDocument());

    expect(usageCredit(policy, 'codex', usage)).toBe(120);
    expect(usageCredit(policy, 'codex', { ...usage, cache_read: 9_999_999 })).toBe(120);
    expect(usageCredit(policy, 'codex', { ...usage, input: 11 })).toBe(121);
  });

  it('rounds the cumulative target once so fractional future multipliers do not drift', () => {
    const policy = {
      ...loadDocument(policyDocument()),
      policy_version: 2,
      provider_multipliers: { codex: 0.5 },
    } as RaidPowerPolicy;

    const firstTarget = usageCredit(policy, 'codex', {
      input: 1, output: 0, cache_read: 0, cache_write: 0, reasoning_output: 0,
    });
    const secondTarget = usageCredit(policy, 'codex', {
      input: 2, output: 0, cache_read: 0, cache_write: 0, reasoning_output: 0,
    });

    expect(firstTarget).toBe(1);
    expect(secondTarget).toBe(1);
  });

  it.each(['claude', 'omp'] as const)('rejects disabled provider %s', (provider) => {
    expect(() => usageCredit(loadDocument(policyDocument()), provider, usage)).toThrow(
      `provider ${provider} is not enabled by Raid Power policy v1`,
    );
  });

  it.each(['claude', 'omp'] as const)(
    'rejects forged v1 multiplier and allowlist entries for %s',
    (provider) => {
      const forgedPolicy = {
        ...loadDocument(policyDocument()),
        enabled_providers: ['codex', provider],
        provider_multipliers: { codex: 1, [provider]: 1 },
      } as RaidPowerPolicy;

      expect(() => usageCredit(forgedPolicy, provider, usage)).toThrow(
        `provider ${provider} is not enabled by Raid Power policy v1`,
      );
    },
  );

  it('requires a provider to be present in the enabled provider allowlist', () => {
    const laterPolicy = {
      ...loadDocument(policyDocument()),
      policy_version: 2,
      enabled_providers: [],
      provider_multipliers: { codex: 0.5 },
    } as RaidPowerPolicy;

    expect(() => usageCredit(laterPolicy, 'codex', usage)).toThrow(
      'provider codex is not enabled by Raid Power policy v2',
    );
  });

  it('uses the specified square-root duration curve with a hard cap', () => {
    const policy = loadDocument(policyDocument());

    expect(durationCredit(policy, -60_000)).toBe(0);
    expect(durationCredit(policy, 60_000)).toBe(2);
    expect(durationCredit(policy, 4 * 60_000)).toBe(4);
    expect(durationCredit(policy, 1_000_000 * 60_000)).toBe(20);
  });

  it('keeps completion fixed and model/effort absent from scoring signatures', () => {
    const policy = loadDocument(policyDocument());

    expect(policy.completion_credit).toBe(5);
    expect(usageCredit.length).toBe(3);
    expect(durationCredit.length).toBe(2);
    expect(usageCredit(policy, 'codex', usage)).toBe(120);
  });
});

describe('Raid Power calibration generator', () => {
  it('requires three real tagged samples for every workload and Codex surface', () => {
    const samples = completeSamples();
    const missing = samples.filter((sample) => !(
      sample.workload === 'short_explanation'
      && sample.surface === 'codex_desktop'
      && sample.usage.input === 100
    ));

    expect(() => generateCalibration(missing)).toThrow(
      'short_explanation/codex_desktop requires at least 3 samples; found 2',
    );
  });

  it('strictly rejects non-Codex, content-bearing, native-ID, and metadata fields', () => {
    const sample = completeSamples()[0];

    for (const forbidden of [
      { prompt: 'DO_NOT_EXPORT' },
      { response: 'DO_NOT_EXPORT' },
      { path: '/DO_NOT_EXPORT' },
      { native_id: 'DO_NOT_EXPORT' },
      { model: 'DO_NOT_SCORE' },
      { effort: 'DO_NOT_SCORE' },
    ]) {
      expect(() => parseCalibrationSamples({
        schema_version: 1,
        samples: [{ ...sample, ...forbidden }],
      })).toThrow();
    }
    expect(() => parseCalibrationSamples({
      schema_version: 1,
      samples: [{ ...sample, provider: 'claude' }],
    })).toThrow();
  });

  it('derives the deterministic v1 policy from workload medians', () => {
    const calibration = generateCalibration(completeSamples());

    expect(calibration.policy).toEqual({
      policy_version: 1,
      enabled_providers: ['codex'],
      usage_weights: {
        input: 1,
        output: 1,
        cache_read: 0,
        cache_write: 1,
        reasoning_output: 1,
      },
      provider_multipliers: { codex: 1.0 },
      completion_credit: 5,
      duration: {
        scale: 5 / Math.sqrt(10),
        cap: 20,
      },
    });
    expect(calibration.baseline).toBe(251);
    expect(calibration.rows).toHaveLength(8);
    expect(calibration.rows.every((row) => row.sample_count === 3)).toBe(true);
    expect(calibration.comparisons.every((comparison) => comparison.difference_percent === 0))
      .toBe(true);
  });

  it('rejects a sample total that exceeds the safe integer range', () => {
    const samples = completeSamples();
    samples[0] = {
      ...samples[0],
      usage: {
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning_output: 0,
      },
    };

    expect(() => generateCalibration(samples)).toThrow(
      'calibration sample total exceeds the safe integer range',
    );
  });

  it('rejects an even median whose exact sum exceeds the safe integer range', () => {
    const samples = completeSamples().map((sample) => {
      if (sample.workload !== 'short_explanation') return sample;
      return {
        ...sample,
        usage: {
          input: sample.surface === 'codex_desktop'
            ? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER - 1,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning_output: 0,
        },
      };
    });

    expect(() => generateCalibration(samples)).toThrow(
      'calibration median sum exceeds the safe integer range',
    );
  });

  it('accepts a large safe integer midpoint without adding the operands', () => {
    const weightedUsage = 6_000_000_000_000_000;
    const samples = completeSamples().map((sample) => ({
      ...sample,
      usage: {
        input: weightedUsage,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning_output: 0,
      },
      duration_ms: 0,
    }));

    const calibration = generateCalibration(samples);

    expect(calibration.baseline).toBe(weightedUsage);
    expect(calibration.policy.completion_credit).toBe(120_000_000_000_000);
    expect(calibration.rows.every((row) => (
      row.median_weighted_usage === weightedUsage
      && row.median_raid_power === 6_120_000_000_000_000
    ))).toBe(true);
  });

  it('preserves an exactly representable half midpoint', () => {
    const samples = completeSamples().map((sample) => ({
      ...sample,
      usage: {
        input: sample.surface === 'codex_desktop' ? 100 : 101,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning_output: 0,
      },
      duration_ms: 0,
    }));

    const calibration = generateCalibration(samples);

    expect(calibration.baseline).toBe(100.5);
    expect(calibration.policy.completion_credit).toBe(2);
  });

  it('renders a content-free report with the required v1 review statements', () => {
    const report = renderCalibrationReport(generateCalibration(completeSamples()));

    expect(report).toContain('Cross-provider comparison is inapplicable to v1.');
    expect(report).toContain('Omp or Claude Code requires a new immutable policy version');
    expect(report).toContain('| Workload | Surface | Samples |');
    expect(report).not.toContain('prompt');
    expect(report).not.toContain('response');
  });

  it('writes byte-identical policy and report artifacts for identical samples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'raid-power-calibration-'));
    const samplesPath = join(directory, 'samples.json');
    const policyA = join(directory, 'policy-a.json');
    const policyB = join(directory, 'policy-b.json');
    const reportA = join(directory, 'report-a.md');
    const reportB = join(directory, 'report-b.md');
    writeFileSync(samplesPath, `${JSON.stringify({
      schema_version: 1,
      samples: completeSamples(),
    })}\n`);

    writeCalibrationArtifacts(samplesPath, policyA, reportA);
    writeCalibrationArtifacts(samplesPath, policyB, reportB);

    expect(readFileSync(policyA, 'utf8')).toBe(readFileSync(policyB, 'utf8'));
    expect(readFileSync(reportA, 'utf8')).toBe(readFileSync(reportB, 'utf8'));
  });

  it('pins the approved 24-sample matrix and committed generated artifacts', () => {
    const samplesPath = join(process.cwd(), 'docs/runtime-raiders/scoring-calibration-v1.json');
    const policyPath = join(process.cwd(), 'config/raid-power-policy-v1.json');
    const reportPath = join(process.cwd(), 'docs/runtime-raiders/scoring-calibration-v1.md');
    const samples = parseCalibrationSamples(JSON.parse(readFileSync(samplesPath, 'utf8')));
    const counts = Object.fromEntries(workloads.flatMap((workload) => (
      (['codex_desktop', 'codex_cli'] as const).map((surface) => [
        `${workload}/${surface}`,
        samples.filter((sample) => (
          sample.workload === workload && sample.surface === surface
        )).length,
      ])
    )));

    expect(samples).toHaveLength(24);
    expect(counts).toEqual(Object.fromEntries(workloads.flatMap((workload) => (
      (['codex_desktop', 'codex_cli'] as const).map((surface) => [
        `${workload}/${surface}`,
        3,
      ])
    ))));

    const calibration = generateCalibration(samples);
    expect(calibration.baseline).toBe(42_715);
    expect(calibration.policy).toEqual({
      policy_version: 1,
      enabled_providers: ['codex'],
      usage_weights: {
        input: 1,
        output: 1,
        cache_read: 0,
        cache_write: 1,
        reasoning_output: 1,
      },
      provider_multipliers: { codex: 1.0 },
      completion_credit: 854,
      duration: {
        scale: 270.0585121783796,
        cap: 3_416,
      },
    });
    expect(calibration.comparisons.map((comparison) => (
      Number(comparison.difference_percent.toFixed(2))
    ))).toEqual([12.05, 0.18, 10.30, 11.68]);
    expect(calibration.comparisons.every((comparison) => comparison.within_25_percent)).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), 'raid-power-golden-'));
    const regeneratedPolicy = join(directory, 'policy.json');
    const regeneratedReport = join(directory, 'report.md');
    writeCalibrationArtifacts(samplesPath, regeneratedPolicy, regeneratedReport);

    expect(readFileSync(regeneratedPolicy)).toEqual(readFileSync(policyPath));
    expect(readFileSync(regeneratedReport)).toEqual(readFileSync(reportPath));
  });
});
