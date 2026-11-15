/** @pullboard-test-input source-cell apps/view */
/** Shouts rows are one fixed grid that never wraps, so the text column starts at the same x in every row [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeViewStyles } from '../../src/io/styles.js';

const css = composeViewStyles();
const rule = selector => [...css.matchAll(new RegExp('(?:^|\\n)' + selector.replace(/[.]/gu, '\\.') + ' \\{([^}]*)\\}', 'gu'))].map(([, body]) => body);

test('clause 1: a thread row keeps fixed state, mark, count and time columns and never wraps [N26]', () => {
  const [row] = rule('.sx-th');
  assert.match(row, /grid-template-columns: 8px 76px minmax\(0, 1fr\) auto/u, 'dot, stage, text, time');
  assert.doesNotMatch(row, /grid-template-columns:[^;]*\bauto\b[^;]*\bauto\b/u);
  assert.match(row, /white-space: nowrap/u);
  assert.match(rule('.sx-tt')[0], /text-overflow: ellipsis/u, 'the title ends in an ellipsis');
  assert.match(rule('.sx-tx')[0], /text-overflow: ellipsis/u, 'the latest words end in an ellipsis');
  assert.match(rule('.sx-n')[0], /min-width: 30px/u, 'the count column is as wide in every row');
});

test('clause 2: the old conversation-row styling is gone, and at phone width the stage column folds away, not the text [N26]', () => {
  assert.doesNotMatch(css, /\.conversation-(row|id|title|preview|heading)/u);
  const phone = css.slice(css.indexOf('@media (max-width: 640px) {\n  .sx-th'));
  assert.match(phone, /\.sx-st \{ display: none; \}/u);
  assert.doesNotMatch(phone.split('\n}')[0], /\.sx-tx \{ display: none/u, 'the shout text is never hidden');
});
