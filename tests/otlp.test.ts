import { describe, it, expect } from 'vitest';
import { parseTokenDataPoints } from '../src/domain/otlp';

function payload(temporality: number, dps: any[]) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'claude_rpg_token', value: { stringValue: 'TOK1' } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: dps },
              },
              { name: 'claude_code.cost.usage', sum: { aggregationTemporality: temporality, dataPoints: [
                { asDouble: 0.42, attributes: [], startTimeUnixNano: '1', timeUnixNano: '2' },
              ] } },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseTokenDataPoints', () => {
  it('extracts token data points with token, type, model, value, temporality', () => {
    const body = payload(1, [
      { asInt: '150', startTimeUnixNano: '100', timeUnixNano: '200',
        attributes: [ { key: 'type', value: { stringValue: 'input' } }, { key: 'model', value: { stringValue: 'claude-opus-4' } } ] },
      { asInt: '40', startTimeUnixNano: '100', timeUnixNano: '200',
        attributes: [ { key: 'type', value: { stringValue: 'output' } } ] },
    ]);
    const pts = parseTokenDataPoints(body);
    expect(pts.length).toBe(2);
    expect(pts[0]).toMatchObject({
      token: 'TOK1', type: 'input', model: 'claude-opus-4', value: 150,
      startTimeUnixNano: '100', temporality: 'delta',
    });
    expect(pts[1]).toMatchObject({ token: 'TOK1', type: 'output', value: 40, temporality: 'delta' });
  });

  it('reads asDouble and cumulative temporality (enum int 2)', () => {
    const body = payload(2, [
      { asDouble: 12, attributes: [ { key: 'type', value: { stringValue: 'cacheCreation' } } ],
        startTimeUnixNano: '5', timeUnixNano: '6' },
    ]);
    const pts = parseTokenDataPoints(body);
    expect(pts[0]).toMatchObject({ type: 'cacheCreation', value: 12, temporality: 'cumulative' });
  });

  it('treats the string enum name as the temporality too', () => {
    const body = payload('AGGREGATION_TEMPORALITY_CUMULATIVE' as any, [
      { asInt: '1', attributes: [ { key: 'type', value: { stringValue: 'input' } } ], startTimeUnixNano: '1', timeUnixNano: '2' },
    ]);
    expect(parseTokenDataPoints(body)[0].temporality).toBe('cumulative');
  });

  it('token is null when the resource attribute is absent', () => {
    const body = {
      resourceMetrics: [ { resource: { attributes: [] }, scopeMetrics: [ { metrics: [
        { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [
          { asInt: '5', attributes: [ { key: 'type', value: { stringValue: 'input' } } ], startTimeUnixNano: '1', timeUnixNano: '2' } ] } } ] } ] } ],
    };
    expect(parseTokenDataPoints(body)[0].token).toBeNull();
  });

  it('returns [] for empty / malformed bodies without throwing', () => {
    expect(parseTokenDataPoints({})).toEqual([]);
    expect(parseTokenDataPoints(null)).toEqual([]);
    expect(parseTokenDataPoints({ resourceMetrics: 'nope' })).toEqual([]);
    expect(parseTokenDataPoints({ resourceMetrics: [{}] })).toEqual([]);
  });
});
