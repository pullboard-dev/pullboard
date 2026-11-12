/** An item check cannot outsource its completion condition to the full suite or CI [S10]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import {
  listItems,
  setItem,
  closeBoard,
  editItem,
} from '../../../../packages/store/index.js';
import { checkPerItemCriterion } from '../../../../packages/items/index.js';
import { PER_ITEM_FULL_SUITE_ENGINE } from '../../../../packages/state/light.js';
import {
  ENGINE_VERSION,
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
const { LIGHT_BRIEF } = e2e;
after(e2e.cleanup);

/** Assert that an add or edit refusal names S10 and tells the author how to fix the bar. */
async function refusal(box, cwd, ...args) {
  const result = (await box.runLocal(cwd, ...args, '--json'));
  assert.equal(result.code, 1, `${args.join(' ')} unexpectedly succeeded: ${result.out}\n${result.err}`);
  assert.match(result.out + result.err, /S10/u);
  assert.match(result.out + result.err, /remove|drop/u, 'the refusal gives the author a direct next step');
}

test('clause 1: add and edit refuse per-item criteria that require the full suite or CI [S10]', async () => {
  const sandbox = e2e.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture coordinator';
  const box = e2e.project('true', sandbox, { withWorktree: false });
  const existing = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Scoped check item', '--criterion', 'The page renders. [test]',
    '--brief', LIGHT_BRIEF, '--check', 'true', '--json'));
  assert.equal(existing.code, 0, existing.err || existing.out);
  const id = JSON.parse(existing.out).item.item_id;
  const original = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out).item_criterion;

  for (const criterion of [
    'The full suite passes as run by the submit gate. [test]',
    'CI must pass before this item is done. [test]',
    'CI passes before this item is done. [test]',
    'CI is green before this item is complete. [test]',
  ]) {
    (await refusal(box, box.repo, 'add', 'web', 'Out-of-scope gate criterion', '--criterion', criterion, '--brief', LIGHT_BRIEF, '--check', 'true'));
    (await refusal(box, box.repo, 'edit', String(id), '--criterion', criterion));
    const after = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
    assert.equal(after.item_criterion, original, 'a rejected edit leaves the stored item bar unchanged');
  }
  assert.doesNotThrow(() => checkPerItemCriterion('The full suite passes as run by the submit gate.', PER_ITEM_FULL_SUITE_ENGINE - 1),
    'historical add/edit events replay under their original engine');
  assert.throws(() => checkPerItemCriterion('The full suite passes as run by the submit gate.', PER_ITEM_FULL_SUITE_ENGINE),
    error => error.code === 'S10');
  assert.throws(() => checkPerItemCriterion('Remove old code. The full suite passes.', PER_ITEM_FULL_SUITE_ENGINE),
    error => error.code === 'S10', 'a separate removal sentence cannot cancel a positive gate clause');

  for (const criterion of [
    'Remove the full-suite requirement from this item. [test]',
    "Drop the words 'the full suite passes as run by the submit gate' from old bars. [test]",
    'CI runs the gate on every push; this item is complete when its named test passes. [test]',
  ]) {
    const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Scoped check item', '--criterion', criterion,
      '--brief', LIGHT_BRIEF, '--check', 'true', '--json'));
    assert.equal(added.code, 0, added.err || added.out);
  }
});

test('clause 2: the coordinator sweep edits open, claimed, and submitted legacy bars while preserving their frozen snapshots [S10]', async () => {
  const sandbox = e2e.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture coordinator';
  const box = e2e.project('true', sandbox);
  const ids = [];
  for (const label of ['Open', 'Claimed', 'Submitted']) {
    const added = (await fixtureAdd(box.runLocal, box.repo, 'web', `${label} legacy bar`, '--criterion', 'The named test passes. [test]',
      '--brief', LIGHT_BRIEF, '--check', 'true', '--json'));
    assert.equal(added.code, 0, added.err || added.out);
    ids.push(JSON.parse(added.out).item.item_id);
  }
  const secondBuilder = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', secondBuilder, '-b', 'web/two');
  assert.match(fixtureJoin(box.run, secondBuilder, 'web').out, /joined as web-2/u);
  assert.equal((await box.runLocal(box.web, 'claim', String(ids[1]))).code, 0);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  let board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try { submitFixture(board, ids[1], { agentId: 'web-1', commit, tree }); }
  finally { closeBoard(board); }
  assert.equal((await box.runLocal(secondBuilder, 'claim', String(ids[2]))).code, 0);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  const original = new Map([
    [ids[0], 'The named test passes [test]. The full suite passes as run by the submit gate.'],
    [ids[1], 'The named test passes [test]. The full suite passes as run by the submit gate.'],
    [ids[2], 'The named test passes [test]. CI must pass before this item is done.'],
  ]);
  let beforeFrozen;
  try {
    for (const id of ids) setItem(board, id, {
      item_criterion: original.get(id),
      item_frozen: `legacy-frozen-${id}`,
      item_frozen_digest: `legacy-digest-${id}`,
    });
    const exact = 'The named test passes [test].';
    const preserveMove = prepareEngineMove(board, 'editItem', [ids[0], { agentId: 'coordinator', criterion: exact,
      reason: 'S10 full-suite strip', preserveFrozen: true }]);
    assert.equal(preserveMove.engine, ENGINE_VERSION, 'a sealed move carries the engine that prepared it');
    assert.ok(preserveMove.engine >= PER_ITEM_FULL_SUITE_ENGINE, 'the preserved-bar edit needs at least the per-item engine');
    assert.throws(() => applyEngineMove(board, { ...preserveMove, engine: PER_ITEM_FULL_SUITE_ENGINE - 1 },
      { sequence: 1, at: new Date().toISOString() }), error => error.code === 'RELAY_MOVE');
    assert.throws(() => editItem(board, ids[0], { agentId: 'web-1', criterion: exact,
      reason: 'S10 full-suite strip', preserveFrozen: true }), error => error.code === 'COORDINATOR_ONLY');
    assert.throws(() => editItem(board, ids[0], { agentId: 'coordinator', criterion: 'An unrelated rewrite [test].',
      reason: 'S10 full-suite strip', preserveFrozen: true }), error => error.code === 'S10');
    assert.throws(() => editItem(board, ids[0], { agentId: 'coordinator', criterion: exact, check: 'false',
      reason: 'S10 full-suite strip', preserveFrozen: true }), error => error.code === 'COORDINATOR_ONLY');
    assert.throws(() => editItem(board, ids[1], { agentId: 'coordinator', criterion: 'An unrelated rewrite [test].',
      reason: 'S10 full-suite strip', preserveFrozen: true }), error => error.code === 'S10');
    beforeFrozen = new Map(listItems(board, { all: true }).filter(item => ids.includes(item.item_id))
      .map(item => [item.item_id, [item.item_frozen, item.item_frozen_digest]]));
  } finally {
    closeBoard(board);
  }
  const sweep = (await box.runLocal(box.repo, 'bar', 'sweep-full-suite', '--json'));
  assert.equal(sweep.code, 0, `${sweep.out}\n${sweep.err}`);
  const result = JSON.parse(sweep.out);
  assert.deepEqual(result.changed.map(row => row.id).sort((a, b) => a - b), ids.slice().sort((a, b) => a - b));
  assert.deepEqual(result.skipped, []);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const after = new Map(listItems(board, { all: true }).filter(item => ids.includes(item.item_id)).map(item => [item.item_id, item]));
    for (const id of ids) {
      assert.equal(after.get(id).item_criterion, 'The named test passes [test].');
      assert.deepEqual([after.get(id).item_frozen, after.get(id).item_frozen_digest], beforeFrozen.get(id));
      const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='edit' ORDER BY event_id DESC LIMIT 1").get(id);
      assert.equal(JSON.parse(event.event_detail).previousCriterion, original.get(id));
    }
  } finally {
    closeBoard(board);
  }
});

