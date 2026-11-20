/** After pullboard split, the parent carries a fact naming every child id [C7,#8917]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';

const CHECK = 'node --test web/handler.test.js';
const CRITERION = '1. the handler returns the canonical result [test]. 2. the handler refuses an empty body [test]. 3. the handler logs the call [test].';

test('cli.journeys-fact-split-parent.after-split-the-parent-carries-a: clause 1: after split, the parent carries a fact naming every child id [C7,#8917]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Handler', '--criterion', CRITERION, '--check', CHECK, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const parent = JSON.parse(added.out).item.item_id;
  const split = await box.runLocal(box.repo, 'split', String(parent), '--json');
  assert.equal(split.code, 0, split.out + split.err);
  const { children } = JSON.parse(split.out);
  assert.equal(children.length, 3);
  const shown = await box.runLocal(box.repo, 'show', String(parent), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  const facts = (JSON.parse(shown.out).thread ?? []).filter(entry => entry.type === 'fact' && /split into/u.test(entry.text ?? ''));
  assert.equal(facts.length, 1, 'one split fact is on the parent');
  for (const id of children) assert.match(facts[0].text, new RegExp(`#${id}\\b`, 'u'), `the fact names child #${id}`);
});
