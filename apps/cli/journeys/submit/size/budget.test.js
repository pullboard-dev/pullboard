/** A configured item budget moves the split note boundary [V4,C7].
 * Material test fixture parent: core616/tests53, submitted383cd010; repaired by core631 whole420/475.
 */
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { expectSplitNotes } from '../../../tests/fixtures/submit/size.js';

test('a configured budget moves the split suggestion boundary [V4,C7]', { timeout: 180_000 }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  await expectSplitNotes(helpers, [[250, 200, false], [401, 200, true]]);
});
