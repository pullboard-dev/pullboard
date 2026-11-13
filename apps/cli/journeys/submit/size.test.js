/** A submit over twice its board item budget advises a split and never blocks [V4,C7].
 * Material test fixture parent: core616/tests53, submitted383cd010; repaired by core631 whole420/475.
 */
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { expectSplitNotes } from '../../tests/fixtures/submit/size.js';

test('a submit far over the size budget prints a split suggestion and still submits [V4,C7]', { timeout: 180_000 }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  await expectSplitNotes(helpers, [[101, 50, true], [250, undefined, true]]);
});
