/** gateSections judges a gate result's sections, a refusal outside every stage included [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateSections } from '../../../../packages/drive/index.js';

test('gateSections judges a refusal outside every stage as a failed proof [C7]', () => {
  const sections = gateSections({ sections: {}, result: { code: 1, error: { code: 'MOVED_DURING_GATE' } } });
  assert.deepEqual(sections.proof, { outcome: 'fail', code: 'MOVED_DURING_GATE' });
  assert.deepEqual(sections.static, { outcome: 'skip' });
});
