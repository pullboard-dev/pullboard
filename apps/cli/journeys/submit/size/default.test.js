/** A submit at or under twice the default item budget prints no split note [V4,C7].
 * Material test fixture parent: core616/tests53, submitted383cd010; repaired by core631 whole420/475.
 */
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { expectSplitNotes } from '../../../tests/fixtures/submit/size.js';

test('a submit at the default budget boundary prints no split suggestion [V4,C7]', { timeout: 180_000 }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  await expectSplitNotes(helpers, [[200, undefined, false], [100, 50, false]]);
});
