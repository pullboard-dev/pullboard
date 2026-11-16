/** A reviewer's reject of a landed item with a coordinator-set check keeps that check unchanged, behind verify.rejectKeepsCheck (default off) [C7,#9637]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const BRIEF = 'Fix the thing.\n\nFiles:\n- web/result.txt\n\nTest: web/result.test.js asserts the result.';
const CHECK = 'node --test web/result.test.js && node scripts/lint.js';
const COMMIT = 'a'.repeat(40);

/** Run `body` with a private machine home holding `settings`, restoring the home afterwards. */
function withSettings(settings, body) {
  const { root } = privateFixtureFiles('pullboard-reject-keeps-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return body();
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

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

const reject = ({ board, id, reviewer }) => store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the result is wrong',
  head: COMMIT, digest: '', policy: 'any', landed: true });

test('clause 1: with verify.rejectKeepsCheck on, a reviewer reject of a landed item reopens it with the check unchanged [C7,#9637]', t => {
  const f = landed(t);
  const result = withSettings({ verify: { rejectKeepsCheck: true } }, () => reject(f));
  assert.equal(store.getItem(f.board, f.id).item_verdict, 'REJECT');
  assert.equal(store.getItem(f.board, result.followUp).item_check, CHECK);
});

test('clause 2: with the setting off (default), the same reject is refused COORDINATOR_CHECK as before [C7,#9637]', t => {
  const f = landed(t);
  assert.throws(() => withSettings({}, () => reject(f)), error => error.code === 'COORDINATOR_CHECK' || /COORDINATOR_CHECK|item check/.test(String(error.message) + String(error.code)));
});

test('clause 3: a reviewer still cannot set a check of their own, even with the setting on [C7,#9637]', t => {
  const f = landed(t);
  assert.throws(() => withSettings({ verify: { rejectKeepsCheck: true } }, () => store.addItem(f.board, { by: f.reviewer, lane: 'web', title: 'x', criterion: '1. y [reasoning]', check: CHECK })),
    error => /check/.test(String(error.message)));
});
