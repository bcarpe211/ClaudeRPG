import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
  join(process.cwd(), 'docs/RUNTIME_RAIDERS_CUTOVER.md'),
  'utf8',
);
const packet = readFileSync(
  join(process.cwd(), 'docs/runtime-raiders/cutover-authorization-packet.md'),
  'utf8',
);

describe('Runtime Raiders stable cutover documentation contract', () => {
  it('uses version-2 rollback records with a stable executable path', () => {
    expect(runbook).toContain('ROLLBACK_RECORD_VERSION=2');
    expect(runbook).toContain('test "$ROLLBACK_RECORD_VERSION" = 2');
    expect(runbook).not.toContain('test "$ROLLBACK_RECORD_VERSION" = 1');
    expect(runbook).toContain('GAME_EXEC_PATH');
    expect(runbook).not.toContain('GAME_EXEC_EXPECTED');
    expect(packet).toContain('rollback record version `2`');
    expect(packet).toContain('GAME_EXEC_PATH');
  });

  it('delegates updater and game-unit gates to the executable helper', () => {
    expect(runbook).toContain(
      'rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"',
    );
    expect(runbook).toContain(
      'rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"',
    );
    expect(runbook).not.toMatch(
      /test "\$\(systemctl is-active "\$UPDATER_(?:TIMER|SERVICE)"\)" = inactive/,
    );
    expect(runbook).not.toMatch(/test "\$GAME_EXEC" =/);
  });

  it('keeps fail-closed cleanup non-recursive while accumulating failures', () => {
    expect(runbook).toContain(
      'sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || cleanup_failed=1',
    );
    expect(runbook).toContain(
      'sudo systemctl stop "$UPDATER_SERVICE" >/dev/null 2>&1 || cleanup_failed=1',
    );
  });

  it('does not select a rollback handler as the ordinary fail-closed handler', () => {
    const rollbackOnly = 'rollback_fail_closed() {\n}\n';
    const ordinaryHandler = rollbackOnly.match(/^fail_closed\(\) \{[\s\S]*?^\}/m)?.[0];

    expect(ordinaryHandler).toBeUndefined();
  });

  it('verifies final updater and game-service state before each safe-state claim', () => {
    const ordinaryHandler = runbook.match(/^fail_closed\(\) \{[\s\S]*?^\}/m)?.[0];
    const rollbackHandler = runbook.match(/^rollback_fail_closed\(\) \{[\s\S]*?^\}/m)?.[0];
    const handlers = [ordinaryHandler, rollbackHandler];

    expect(handlers).toHaveLength(2);
    expect(ordinaryHandler).toBeDefined();
    expect(rollbackHandler).toBeDefined();
    expect(ordinaryHandler).not.toBe(rollbackHandler);
    for (const handler of handlers) {
      expect(handler).toContain("local service_state=''");
      expect(handler).toContain(
        'rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE" || cleanup_failed=1',
      );
      expect(handler).toContain(
        'rr_observe_systemctl service_state is-active "$SERVICE" || cleanup_failed=1',
      );
      expect(handler).toContain('test "$service_state" = inactive || cleanup_failed=1');
      expect(handler).toContain('if test "$cleanup_failed" = 0; then');
      expect(handler).toContain('safe state could not be verified');
    }
  });
});
