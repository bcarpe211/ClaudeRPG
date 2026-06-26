export interface SnippetArgs {
  token: string;
  host: string;
  port: number;
}

export function buildSetupSnippet({ token, host, port }: SnippetArgs): string {
  return `# --- ClaudeRPG telemetry setup (add to ~/.zshrc or ~/.bashrc) ---
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://${host}:${port}
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_RESOURCE_ATTRIBUTES=claude_rpg_token=${token}

# Toggle your contribution on/off while on the office network:
rpg_off() { export CLAUDE_CODE_ENABLE_TELEMETRY=0; echo "ClaudeRPG: paused"; }
rpg_on()  { export CLAUDE_CODE_ENABLE_TELEMETRY=1; echo "ClaudeRPG: active"; }
# --- end ClaudeRPG setup ---`;
}
