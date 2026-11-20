/** @pullboard-test-input apps/view/src/io/page/actions.js */
/** @pullboard-world-pin reads actions.js source to prove the result panel has no timer; real layout needs a browser. */
/** The result panel stays until the next pick, arrow move or decision, and no timer hides it [H12,#9529]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../../../src/io/page/actions.js', import.meta.url), 'utf8');
const act = SOURCE.slice(SOURCE.indexOf('async function act('), SOURCE.indexOf('\n}\n', SOURCE.indexOf('async function act(')));

/** The page's own dismissResult, run against a stand-in panel so the test runs what the page runs. */
function dismissWith(panel) {
  const source = /function dismissResult\(\) \{.*\}$/mu.exec(SOURCE)[0];
  return new Function('$', `${source}; return dismissResult;`)(() => panel);
}

test('view.x-io-page-dismiss.clause-1-no-timer-hides-the-result: clause 1: no timer hides the result panel after a decision [H12,#9529]', () => {
  assert.doesNotMatch(act, /setTimeout/u, 'act schedules no timer');
  assert.doesNotMatch(SOURCE, /view\.closing/u, 'nothing keeps a closing timer');
  assert.doesNotMatch(act, /out\.hidden = true/u, 'act never hides its own result');
});

test('view.x-io-page-dismiss.clause-1-a-pick-an-arrow-move: clause 1: a pick, an arrow move and a row click dismiss the result [H12,#9529]', () => {
  assert.match(/function pick\([^)]*\) \{\s*dismissResult\(\);/u.exec(SOURCE)?.[0] ?? '', /dismissResult/u, 'pick dismisses');
  assert.match(SOURCE, /next !== view\.row\[kind\]\) \{ dismissResult\(\);/u, 'an arrow move dismisses');
  assert.match(SOURCE, /dismissResult\(\); view\.row\[kind\] = id;/u, 'a row click dismisses');
  const panel = { hidden: false, textContent: '$ pullboard approve 1' };
  dismissWith(panel)();
  assert.equal(panel.hidden, true, 'a settled result is hidden by the pick');
  const running = { hidden: false, textContent: 'running…' };
  dismissWith(running)();
  assert.equal(running.hidden, false, 'a move still running is not hidden');
});

test('view.x-io-page-dismiss.clause-2-settling-a-decision-only-fills: clause 2: settling a decision only fills the panel, never moves the page [H12,#9529]', () => {
  const settle = act.slice(act.indexOf('if (latest()) {'), act.indexOf('refreshThrough'));
  assert.doesNotMatch(settle, /hidden|remove\(|insertAdjacentElement|scrollTo|scrollBy/u, 'the settle step adds no layout change');
  assert.equal([...settle.matchAll(/scrollIntoView/gu)].length, 1, 'one scroll reveals the result, once');
});
