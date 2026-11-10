/** The item size budget defaults to 100 and rejects invalid board settings [V4,C7].
 * Material test fixture parent: core616/tests53, submitted383cd010; repaired by core631 whole420/475.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../index.js';

// AFTER-only validation controls; the original causal case and every assertion above are unchanged.
test('the item size budget defaults to 100 and rejects invalid board settings [V4,C7]', () => {
  assert.equal(configFromSource('{}').itemSizeBudget, 100);
  for (const budget of [1, 50, 200]) {
    assert.equal(configFromSource(JSON.stringify({ itemSizeBudget: budget })).itemSizeBudget, budget);
  }
  for (const budget of [0, -1, 1.5, '50', null, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => configFromSource(JSON.stringify({ itemSizeBudget: budget })), { code: 'BAD_CONFIG', message: /itemSizeBudget/u });
  }
});
