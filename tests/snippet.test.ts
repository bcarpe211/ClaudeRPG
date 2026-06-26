import { describe, it, expect } from 'vitest';
import { buildSetupSnippet } from '../src/domain/snippet';

describe('buildSetupSnippet', () => {
  it('embeds token, host, and port and includes toggles', () => {
    const s = buildSetupSnippet({
      token: 'ABC123',
      host: 'claude-rpg.local',
      port: 8080,
    });
    expect(s).toContain('CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(s).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
    expect(s).toContain('http://claude-rpg.local:8080');
    expect(s).toContain('OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta');
    expect(s).toContain('claude_rpg_token=ABC123');
    expect(s).toContain('rpg_off()');
    expect(s).toContain('rpg_on()');
  });
});
