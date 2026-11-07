/** An item whose bar names a coordinator-owned path is refused with CROSS_OWNERSHIP and the split as next step [C7,#2650]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** A real repo with lanes web (web/) and api (api/), and a joined web seat in its own worktree. */
function fixture() {
  const box = helpers.project('true', helpers.sandbox());
  return { repo: box.repo, web: box.web, run: box.run };
}

/** File an item from a directory with the given criterion and brief and return the exit code and parsed result. */
function add(box, cwd, lane, criterion, brief) {
  const result = fixtureAdd(box.run, cwd, lane, 'Cross item', '--route', 'strong', '--specs', 'G1', '--criterion', criterion, '--brief', brief, '--json');
  return { code: result.code, doc: result.code === 0 ? JSON.parse(result.out) : JSON.parse(result.out).error };
}

test('clause 1: a bar naming a coordinator-owned path is refused with the split as next step [C7,#2650]', () => {
  const box = fixture();
  const refused = add(box, box.web, 'web', 'The hook .githooks/pre-commit refuses it [test].', 'Files:\n- web/a.js\nTest:\n- web/a.test.js');
  assert.notEqual(refused.code, 0);
  assert.equal(refused.doc.code, 'CROSS_OWNERSHIP');
  assert.match(refused.doc.message, /\.githooks\/pre-commit/u);
  assert.match(refused.doc.next ?? refused.doc.nextStep ?? JSON.stringify(refused.doc), /add coordinator .* --after <lane item id>/u);
  const inBrief = add(box, box.web, 'web', 'It works [test].', 'Files:\n- web/a.js\n- pullboard.json\nTest:\n- web/a.test.js');
  assert.equal(inBrief.doc.code, 'CROSS_OWNERSHIP');
  const clean = add(box, box.web, 'web', 'It works [test].', 'Files:\n- web/a.js\nTest:\n- web/a.test.js');
  assert.equal(clean.code, 0, JSON.stringify(clean.doc));
});
