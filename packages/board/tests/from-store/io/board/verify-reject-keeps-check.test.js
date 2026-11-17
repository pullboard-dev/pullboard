/** A reviewer's reject of a landed item with a coordinator-set check keeps that check unchanged, behind verify.rejectKeepsCheck (default off) [C7,#9637]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

const BRIEF = 'Fix the thing.\n\nFiles:\n- web/result.txt\n\nTest: web/result.test.js asserts the result.';
const CHECK = 'node --test web/result.test.js && node scripts/lint.js';
const COMMIT = 'a'.repeat(40);

/** A mid item with a non-test check, landed by a forced merge, and a reviewer seat. */
function landed(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const reviewer = cellSeat(board, { lane: 'web', path: `${project.dir}/reviewer` }).id;
  const row = cellItem(board, { lane: 'web', title: 'Landed mid', criterion: '1. It works [test]', specIds: ['G1'], route: 'mid', brief: BRIEF, check: CHECK });
  store.merged(board, row.item_id, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'test fixture' });
  return { board, id: row.item_id, reviewer };
}

const reject = ({ board, id, reviewer }, extra = {}) => store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the result is wrong',
  head: COMMIT, digest: '', policy: 'any', landed: true, ...extra });

test('clause 1: with the recorded keepCheck argument, a reviewer reject of a landed item reopens it with the check unchanged and records keptCheckFrom [C7,#9637]', t => {
  const f = landed(t);
  const result = reject(f, { keepCheck: true });
  assert.equal(store.getItem(f.board, f.id).item_verdict, 'REJECT');
  assert.equal(store.getItem(f.board, result.followUp).item_check, CHECK);
  const event = store.events(f.board, { itemId: f.id }).filter(e => e.event_kind === 'verify').at(-1);
  assert.equal(JSON.parse(event.event_detail).keptCheckFrom, CHECK);
});

test('clause 2: with no keepCheck argument (the default), the same reject is refused COORDINATOR_CHECK as before [C7,#9637]', t => {
  const f = landed(t);
  assert.throws(() => reject(f), error => error.code === 'COORDINATOR_CHECK' || /COORDINATOR_CHECK|item check/.test(String(error.message) + String(error.code)));
});

test('clause 3: a reviewer still cannot set a check of their own, with or without the argument [C7,#9637]', t => {
  const f = landed(t);
  assert.throws(() => store.addItem(f.board, { by: f.reviewer, lane: 'web', title: 'x', criterion: '1. y [reasoning]', check: CHECK }), error => /check/.test(String(error.message)));
  assert.throws(() => store.addItem(f.board, { by: f.reviewer, lane: 'web', title: 'x', criterion: '1. y [reasoning]', check: CHECK, keptCheckFrom: 'other' }), error => /check/.test(String(error.message)));
});

test('clause 4: replaying the recorded move with verify.rejectKeepsCheck OFF on the replaying machine gives the same result [C7,#9637]', t => {
  const f = landed(t);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = `${f.board.gitRoot}/no-machine-settings`;
  try {
    const result = reject(f, { keepCheck: true });
    assert.equal(store.getItem(f.board, result.followUp).item_check, CHECK, 'the move trusts its recorded argument, not this machine\'s setting');
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
});
