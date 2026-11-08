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

const LANE_BRIEF = 'Files:\n- web/a.js\nTest:\n- web/a.test.js';
const HOOK = 'The hook .githooks/pre-commit refuses it [test].';
const SPLIT = /add coordinator .* --after <lane item id>/u;

test('clause 1: add of an item whose bar names a coordinator-owned path refuses with CROSS_OWNERSHIP, through the real add command [C7,#2650]', () => {
  const box = fixture();
  const refused = add(box, box.web, 'web', HOOK, LANE_BRIEF);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.doc.code, 'CROSS_OWNERSHIP');
  assert.match(refused.doc.message, /\.githooks\/pre-commit/u);
  const inBrief = add(box, box.web, 'web', 'It works [test].', 'Files:\n- web/a.js\n- pullboard.json\nTest:\n- web/a.test.js');
  assert.equal(inBrief.doc.code, 'CROSS_OWNERSHIP');
  const clean = add(box, box.web, 'web', 'It works [test].', LANE_BRIEF);
  assert.equal(clean.code, 0, JSON.stringify(clean.doc));
});

test('clause 2: claim of an existing item whose bar names a coordinator-owned path refuses with the same code before any claim is recorded, through the real claim command [C7,#2650]', () => {
  const box = fixture();
  const filed = add(box, box.repo, 'web', HOOK, LANE_BRIEF);
  assert.equal(filed.code, 0, `the coordinator may file any path: ${JSON.stringify(filed.doc)}`);
  const id = filed.doc.item?.item_id ?? filed.doc.item_id;
  const result = box.run(box.web, 'claim', String(id), '--json');
  assert.notEqual(result.code, 0, result.out + result.err);
  const refused = JSON.parse(result.out).error;
  assert.equal(refused.code, 'CROSS_OWNERSHIP');
  assert.match(refused.message, /\.githooks\/pre-commit/u);
  const shown = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal((shown.item ?? shown).item_status, 'open', 'no claim was recorded');
});

test('clause 3: both refusals next step files the coordinator piece with --after the lane item, for add and for claim [C7,#2650]', () => {
  const box = fixture();
  const added = add(box, box.web, 'web', HOOK, LANE_BRIEF).doc;
  assert.match(added.next ?? added.nextStep ?? JSON.stringify(added), SPLIT, 'add names the split');
  const filed = add(box, box.repo, 'web', HOOK, LANE_BRIEF);
  const id = filed.doc.item?.item_id ?? filed.doc.item_id;
  const claimed = JSON.parse(box.run(box.web, 'claim', String(id), '--json').out).error;
  assert.match(claimed.next ?? claimed.nextStep ?? JSON.stringify(claimed), SPLIT, 'claim names the split');
});
