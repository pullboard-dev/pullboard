/** A landing item with no readable test plan falls back to running tests and lands; a missing plan never stops landing [C7,#2897]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { json } from '../../../tests/fixtures/land/board.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** Add, join and claim one item whose check is the given command, or no check at all. */
async function item(box, number, check) {
  const file = `web/land-${number}.test.js`;
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: `Land fixture ${number}`,
    criterion: `land fixture ${number} remains valid`, check: check ? check(file) : null, args: ['--specs', 'G1'] }).item_id;
  assert.equal((await box.runLocal(path, 'claim', String(id))).code, 0);
  return { path, item: id, file };
}

/** A literal test plan: the project's own focused runner on the item's test file. */
const literal = box => file => `${box.affected} ${file}`;
/** A check landing cannot read as a test plan: a helper script rather than the test runner. */
const opaque = box => file => `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`;

/** Submit and accept every entry through the real hooks, then run one plain land. */
async function landAll(box, entries) {
  for (const entry of entries) submitItem(box, entry);
  for (const entry of entries) acceptItem(box, entry);
  return box.runLocal(box.repo, 'land', '--json');
}

test('items with no check or an unreadable check land with a literal-plan item, with no LAND_DIAGNOSTIC [C7,#2897]', { timeout: 300_000 }, // budget: three real submits, accepts and one landing; hang ceiling only.
async () => {
  const box = landProject();
  const entries = [await item(box, 1, literal(box)), await item(box, 2, null), await item(box, 3, opaque(box))];
  const landed = await landAll(box, entries);
  assert.equal(landed.code, 0, landed.out + landed.err);
  assert.doesNotMatch(landed.out + landed.err, /LAND_DIAGNOSTIC/u);
  const result = JSON.parse(landed.out);
  assert.equal(result.batch?.state, 'landed', landed.out);
  assert.deepEqual([...result.landed].sort((a, b) => a - b), entries.map(entry => entry.item), 'all three items land');
  for (const entry of entries) assert.ok(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, `#${entry.item} recorded its merge`);
});

test('in a project whose test command is not Node, verified items with passing gates land [C7,#2897]', { timeout: 300_000 }, // budget: two real submits, accepts and one landing; hang ceiling only.
async () => {
  const box = landProject();
  const entries = [await item(box, 1, opaque(box)), await item(box, 2, opaque(box))];
  const landed = await landAll(box, entries);
  assert.equal(landed.code, 0, landed.out + landed.err);
  const result = JSON.parse(landed.out);
  assert.equal(result.batch?.state, 'landed', landed.out);
  assert.deepEqual([...result.landed].sort((a, b) => a - b), entries.map(entry => entry.item));
});
