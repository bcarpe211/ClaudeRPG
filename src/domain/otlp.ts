export type Temporality = 'delta' | 'cumulative';

export interface TokenDataPoint {
  token: string | null; // claude_rpg_token resource attribute, or null
  type: string; // input | output | cacheRead | cacheCreation
  model: string; // model attribute, or '' if absent
  value: number; // counter value for this data point
  startTimeUnixNano: string; // identifies a counter series; '' if absent
  temporality: Temporality;
}

const TOKEN_METRIC = 'claude_code.token.usage';

function asArray(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

function findAttr(attrs: unknown, key: string): string | null {
  for (const a of asArray(attrs)) {
    if (a && a.key === key) {
      const v = a.value ?? {};
      if (typeof v.stringValue === 'string') return v.stringValue;
      if (typeof v.intValue === 'string') return v.intValue;
      if (typeof v.intValue === 'number') return String(v.intValue);
      return null;
    }
  }
  return null;
}

function readValue(dp: any): number {
  if (dp == null) return 0;
  if (dp.asInt !== undefined) {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : 0;
  }
  if (dp.asDouble !== undefined) {
    const n = Number(dp.asDouble);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function readTemporality(sum: any): Temporality {
  const t = sum?.aggregationTemporality;
  if (t === 1 || t === '1' || t === 'AGGREGATION_TEMPORALITY_DELTA') return 'delta';
  // Default to cumulative for 2, the enum name, or anything unexpected — the
  // server's series-diff path is the safe interpretation of an unknown value.
  return 'cumulative';
}

/** Parse an OTLP/JSON metrics body into flat token data points. Never throws. */
export function parseTokenDataPoints(body: unknown): TokenDataPoint[] {
  const out: TokenDataPoint[] = [];
  const root = body as any;
  for (const rm of asArray(root?.resourceMetrics)) {
    const token = findAttr(rm?.resource?.attributes, 'claude_rpg_token');
    for (const sm of asArray(rm?.scopeMetrics)) {
      for (const metric of asArray(sm?.metrics)) {
        if (metric?.name !== TOKEN_METRIC) continue;
        const sum = metric.sum;
        const temporality = readTemporality(sum);
        for (const dp of asArray(sum?.dataPoints)) {
          const type = findAttr(dp?.attributes, 'type');
          if (!type) continue; // a token data point must have a type
          out.push({
            token,
            type,
            model: findAttr(dp?.attributes, 'model') ?? '',
            value: readValue(dp),
            startTimeUnixNano:
              typeof dp?.startTimeUnixNano === 'string' ? dp.startTimeUnixNano : '',
            temporality,
          });
        }
      }
    }
  }
  return out;
}
