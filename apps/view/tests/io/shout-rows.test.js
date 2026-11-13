/** @pullboard-test-input source-cell apps/view */
/** #7311: Shouts rows keep the shout text on a phone and align the text column in every row [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeViewStyles } from '../../src/io/styles.js';

const css = composeViewStyles();
const rule = selector => [...css.matchAll(new RegExp(selector.replace(/[.]/gu, '\\.') + ' \\{([^}]*)\\}', 'gu'))].map(([, body]) => body);

test('clause 1: at phone width the shout text is never hidden and sits after the title in its own column [N26]', () => {
  const phone = css.slice(css.lastIndexOf('.conversation-row { grid-template-columns: 38px'));
  assert.match(phone, /^\.conversation-row \{ grid-template-columns: 38px minmax\(0, 1fr\) minmax\(0, 1fr\) 28px 40px/u, 'id, title, text, count, age');
  assert.doesNotMatch(rule('.conversation-preview').join('\n'), /display: none/u);
  assert.doesNotMatch(css.slice(css.lastIndexOf('.conversation-row { grid-template-columns: 38px')).split('\n}')[0], /\.conversation-preview \{ display: none/u);
  assert.match(rule('.conversation-id, .conversation-title, .conversation-preview')[0], /text-overflow: ellipsis/u, 'the text ends in an ellipsis');
});

test('clause 2: every row has fixed count and age columns, so the text column starts at the same x [N26]', () => {
  const [row] = rule('.conversation-row');
  assert.match(row, /grid-template-columns: 44px minmax\(0, 2fr\) minmax\(0, 3fr\) 32px 48px/u, 'no auto column that grows with a count like 25');
  assert.doesNotMatch(row, /grid-template-columns:[^;]*\bauto\b/u);
});
