import { METRICS_INGEST_LIMITS } from './metrics-policy';

export type Temporality = 'delta' | 'cumulative';

export interface TokenDataPoint {
  token: string | null; // claude_rpg_token resource attribute, or null
  type: string; // input | output | cacheRead | cacheCreation
  model: string; // model attribute, or '' if absent
  value: number; // counter value for this data point
  startTimeUnixNano: string; // identifies a counter series; '' if absent
  timeUnixNano: string; // stable identity of this exported data point; '' if absent
  temporality: Temporality;
}

const TOKEN_METRIC = 'claude_code.token.usage';

function asArray(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

function exceedsAttributeLimit(attrs: unknown): boolean {
  return Array.isArray(attrs)
    && attrs.length > METRICS_INGEST_LIMITS.maxAttributesPerCollection;
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

function readValue(dp: any): number | undefined {
  if (dp == null) return undefined;
  if (dp.asInt !== undefined) {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : undefined;
  }
  if (dp.asDouble !== undefined) {
    const n = Number(dp.asDouble);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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
  let dataPointCount = 0;
  for (const rm of asArray(root?.resourceMetrics)) {
    if (exceedsAttributeLimit(rm?.resource?.attributes)) return [];
    const token = findAttr(rm?.resource?.attributes, 'claude_rpg_token');
    for (const sm of asArray(rm?.scopeMetrics)) {
      if (exceedsAttributeLimit(sm?.scope?.attributes)) return [];
      for (const metric of asArray(sm?.metrics)) {
        const sum = metric.sum;
        const dataPoints = asArray(sum?.dataPoints);
        dataPointCount += dataPoints.length;
        if (dataPointCount > METRICS_INGEST_LIMITS.maxDataPoints) return [];
        const temporality = readTemporality(sum);
        for (const dp of dataPoints) {
          if (exceedsAttributeLimit(dp?.attributes)) return [];
          if (metric?.name !== TOKEN_METRIC) continue;
          const type = findAttr(dp?.attributes, 'type');
          if (!type) continue; // a token data point must have a type
          const value = readValue(dp);
          if (value === undefined) continue;
          out.push({
            token,
            type,
            model: findAttr(dp?.attributes, 'model') ?? '',
            value,
            startTimeUnixNano:
              typeof dp?.startTimeUnixNano === 'string' ? dp.startTimeUnixNano : '',
            timeUnixNano:
              typeof dp?.timeUnixNano === 'string' ? dp.timeUnixNano : '',
            temporality,
          });
        }
      }
    }
  }
  return out;
}
