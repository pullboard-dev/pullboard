/** @pullboard-test-input apps/view/src/io/activity.css */
/** @pullboard-world-pin reads the shipped Activity stylesheet to prove the narrow legend cuts with an ellipsis; no browser is needed for the rule text. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../../src/io/activity.css', import.meta.url), 'utf8');

test('view.x-io-activity-narrow.clause-1-the-legend-lines-are-block: clause 1: the legend lines are block lines that cut with an ellipsis, and the narrow resource bars keep a fixed width [N26,#7308]', () => {
  assert.match(css, /\.act-lg > div \{[^}]*text-overflow: ellipsis/u, 'the legend lines cut with an ellipsis');
  assert.doesNotMatch(css, /\.act-lg > div \{[^}]*display: flex/u, 'an ellipsis needs a block line, not a flex row');
  assert.match(css, /svg\.split, svg\.load \{ flex: 0 0 56px/u, 'the Runners load bar has the Agents bar width');
});
