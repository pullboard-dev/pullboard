/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** Shouts rows are one fixed grid that never wraps, so the text column starts at the same x in every row [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeViewStyles } from '../../src/io/styles.js';
import { shoutsModel } from '../../src/logic/panel/model.js';
import { shoutsHtml } from '../../src/logic/panel/render.js';

const css = composeViewStyles();
const rule = selector => [...css.matchAll(new RegExp('(?:^|\\n)' + selector.replace(/[.]/gu, '\\.') + ' \\{([^}]*)\\}', 'gu'))].map(([, body]) => body);

test('view.x-io-shout-rows.clause-1-a-thread-row-keeps-fixed: clause 1: a thread row keeps fixed state, mark, count and time columns and never wraps [N26]', () => {
  const [row] = rule('.sx-th');
  assert.match(row, /grid-template-columns: 8px 76px minmax\(0, 1fr\) auto/u, 'dot, stage, text, time');
  assert.doesNotMatch(row, /grid-template-columns:[^;]*\bauto\b[^;]*\bauto\b/u);
  assert.match(row, /white-space: nowrap/u);
  assert.match(rule('.sx-tt')[0], /text-overflow: ellipsis/u, 'the title ends in an ellipsis');
  assert.match(rule('.sx-tx')[0], /text-overflow: ellipsis/u, 'the latest words end in an ellipsis');
  assert.match(rule('.sx-n')[0], /min-width: 30px/u, 'the count column is as wide in every row');
});

test('view.x-io-shout-rows.clause-2-the-old-conversation-row-styling: clause 2: the old conversation-row styling is gone, and at phone width the stage column folds away, not the text [N26]', () => {
  assert.doesNotMatch(css, /\.conversation-(row|id|title|preview|heading)/u);
  const phone = css.slice(css.indexOf('@media (max-width: 640px) {\n  .sx-th'));
  assert.match(phone, /\.sx-st \{ display: none; \}/u);
  assert.doesNotMatch(phone.split('\n}')[0], /\.sx-tx \{ display: none/u, 'the shout text is never hidden');
});

test('view.io-shout-rows.shows-shout-number: clause 1: every shout row on the Shouts screen displays its shout id as #N in a muted style that keeps the row to one line [N26]', () => {
  const today = Date.parse('2026-11-13T00:00:00Z');
  const message = { id: 9804, from: 'coordinator', to: 'person', at: new Date(today + 36e5).toISOString(), ms: today + 36e5, text: 'words', decision: false, answers: null, item: '613' };
  const format = { clock: iso => iso.slice(11, 16), ago: () => '1m', day: iso => iso.slice(5, 10), startOfToday: today };
  const html = shoutsHtml(shoutsModel({ messages: [message], items: {}, startOfToday: today, openKey: 'item:613' }), format);
  assert.match(html, /<div class="sx-msg[^"]*" id="shout-9804"[^>]*>[\s\S]*?<span class="sx-sid"[^>]*>#9804<\/span>/u, 'the row shows #9804');
  assert.match(rule('.sx-sid')[0], /color: var\(--ink-faint\)/u, 'muted like the time beside it');
  assert.match(rule('.sx-sid')[0], /white-space: nowrap/u, 'never wraps');
  assert.match(rule('.sx-msg')[0], /grid-template-columns: 118px minmax\(0, 1fr\) auto 62px/u, 'desktop keeps one line with its own column');
  const phone = css.slice(css.indexOf('@media (max-width: 640px) {\n  .sx-th'));
  assert.match(phone, /\.sx-msg \.sx-sid \{ grid-column: 2; grid-row: 1; \}/u, 'on a phone it rides the first line beside the time');
});
