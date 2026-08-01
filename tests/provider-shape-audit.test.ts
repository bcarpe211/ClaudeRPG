import { expect, it } from 'vitest';
import { auditJsonlShape } from '../tools/runtime-raiders/provider-shape-audit';

it('reports structure without returning record values', () => {
  const shape = auditJsonlShape([
    JSON.stringify({ type: 'message', cwd: '/DO_NOT_EXPORT', message: { role: 'user', content: 'DO_NOT_EXPORT' } }),
  ]);
  const rendered = JSON.stringify(shape);
  expect(rendered).toContain('message');
  expect(rendered).toContain('content');
  expect(rendered).not.toContain('DO_NOT_EXPORT');
});
