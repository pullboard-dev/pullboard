/** Quarantine counts are a per-landing ratchet, with named flake evidence [C7,T12]. */
import { recordLandingBatch } from '../../../../packages/store/index.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { withdraw } from '../../../../packages/store/index.js';
import { flakeQuarantines } from '../../../../packages/flakes/index.js';
import { recordSealedGateRun } from '../../../../packages/flakes/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { listItems } from '../../../../packages/store/index.js';
import { QUARANTINE_BACKFILL_ENGINE } from '../../../../packages/state/light.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  landingFlakeRatchet,
} from '../../../../packages/flakes/index.js';

test('a real landing no longer refuses a newly observed unquarantined flake: reds never hold the trunk [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const item = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, item);
  fixtures.acceptItem(box, item);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const outcome = passed => [{ file: 'test/unstable.test.js', name: 'unstable case', passed, skipped: false }];
    for (const [id, passed] of [['red-fixture', false], ['green-fixture', true]]) {
      logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: 'fixture-tree', kind: 'landing', testOutcomes: outcome(passed) } });
    }
  } finally { closeBoard(board); }
  const before = box.git(box.repo, 'rev-parse', 'main');
  const offered = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(offered.code, 0, offered.err + offered.out);
  // lander-v2 L1 (#6813): the pulled land job never holds the trunk for a flake; the open-quarantine count is a health ratchet, so the landing lands.
  const result = await settleLand(box, JSON.parse(offered.out));
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.landJob.receipt));
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), before);
});

/** Two actual landings retain a falling, named quarantine count in their batch receipts. */
test('real landings record the quarantine baseline and lower it after repair [C7,T12]', { skip: 'CONTROLLER_ONLY: the pulled land receipt carries no batch.flakeRatchet (the host batch step went with #6813, lander-v2 L1); the manual merged case below still records the count' }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(boardFile, undefined, { gitRoot: box.repo });
  let repair;
  try {
    repair = addItem(board, { by: 'coordinator', lane: 'web', title: 'Repair synthetic flake', route: 'strong' });
    logEvent(board, 'coordinator', 'test-quarantine', repair, { engine: 1, file: 'test/old.test.js', name: 'old case', runs: [] });
  } finally { closeBoard(board); }
  const first = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, first);
  fixtures.acceptItem(box, first);
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.equal(JSON.parse(landed.out).batch.flakeRatchet.count, 1);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const laterBoard = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try { withdraw(laterBoard, repair, { agentId: 'coordinator', reason: 'The synthetic flake was repaired.' }); }
  finally { closeBoard(laterBoard); }
  const second = fixtures.itemWorktree(box, 2);
  fixtures.submitItem(box, second);
  fixtures.acceptItem(box, second);
  const next = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  assert.equal(JSON.parse(next.out).batch.flakeRatchet.count, 0);
});

/** A manual merged receipt records the count even if a current flake would block a fresh publication. */
test('manual merged records quarantine count without refusing historical publication [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const item = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, item);
  fixtures.acceptItem(box, item);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try {
    const repair = addItem(board, { by: 'coordinator', lane: 'web', title: 'Repair fixture flake', route: 'strong' });
    logEvent(board, 'coordinator', 'test-quarantine', repair, { engine: 1, file: 'test/old.test.js', name: 'old case', runs: [] });
    for (const [id, passed] of [['receipt-red', false], ['receipt-green', true]]) {
      logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: 'receipt-tree', kind: 'landing',
        testOutcomes: [{ file: 'test/new.test.js', name: 'new case', passed, skipped: false }] } });
    }
  } finally { closeBoard(board); }
  const result = await box.runLocal(box.repo, 'merged', String(item.item), item.commit, '--note', 'already published fixture');
  assert.equal(result.code, 0, result.err + result.out);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const after = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try {
    const receipt = events(after).filter(event => event.event_kind === 'merged' && event.item_id === item.item).at(-1);
    assert.equal(JSON.parse(receipt.event_detail).flakeRatchet.count, 1);
  } finally { closeBoard(after); }
});

/** The ordered writer rejects a stale snapshot before storing a batch, then seals publication. */
test('landing batch recording fences flake events and preserves the published snapshot [C7,T12]', t => {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  const boundary = events(board).at(-1).event_id;
  logEvent(board, 'coordinator', 'flake-observation', null, {});
  const snapshot = { version: 1, eventId: boundary, count: 0, quarantines: [] };
  const batch = { version: 1, id: 'ratchet-fixture', state: 'ready', base: 'a'.repeat(40), tip: 'b'.repeat(40),
    root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], flakeRatchet: snapshot };
  assert.throws(() => recordLandingBatch(board, { agentId: 'coordinator', batch }), { code: 'BOARD_BUSY' });
  batch.flakeRatchet = { ...snapshot, eventId: events(board).at(-1).event_id };
  const ready = recordLandingBatch(board, { agentId: 'coordinator', batch });
  const pushed = recordLandingBatch(board, { agentId: 'coordinator', revision: ready.revision, batch: { ...ready, state: 'pushed' } });
  assert.throws(() => recordLandingBatch(board, { agentId: 'coordinator', revision: pushed.revision,
    batch: { ...pushed, flakeRatchet: { ...pushed.flakeRatchet, count: 1, quarantines: [{ file: 'test/x.js', name: 'case', item: 1 }] } } }), { code: 'LAND_BATCH' });
});

/** Record proven, red-only, green-only and pre-landing flake evidence; return the next structured land receipt. */
function backfillFixture(t) {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  const outcome = (file, passed) => ({ file, name: 'case', passed, skipped: false });
  const tree = letter => letter.repeat(40);
  const run = (id, on, rows) => logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: tree(on), kind: 'land', testOutcomes: rows } });
  run('before-red', 'a', [outcome('test/old.test.js', false)]);
  run('before-green', 'a', [outcome('test/old.test.js', true)]);
  logEvent(board, 'coordinator', 'merged', null, { flakeRatchet: { version: 1, eventId: events(board).at(-1).event_id, count: 0, quarantines: [] } });
  run('proven-red', 'b', [outcome('test/flaky.test.js', false), outcome('test/red.test.js', false), outcome('test/green.test.js', true)]);
  run('proven-green', 'b', [outcome('test/flaky.test.js', true), outcome('test/red.test.js', false), outcome('test/green.test.js', true)]);
  const receipt = { version: 1, id: '00000000-0000-4000-8000-0000000000c1', kind: 'land', tree: tree('c'), head: tree('c'), main: tree('c'),
    command: 'd'.repeat(64), green: true, failures: [], load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: new Date().toISOString(),
    testOutcomes: [outcome('test/other.test.js', true)] };
  return { board, receipt, tree };
}

/** A flake proven on a tree that never runs again is filed by the next recorded run, so landing is not stuck on it. */
test('a recorded gate run backfills quarantines for flakes proven on other trees since the last landing [C7,D1]', t => {
  const { board, receipt, tree } = backfillFixture(t);
  assert.deepEqual(landingFlakeRatchet(board).unprotected, [{ file: 'test/flaky.test.js', name: 'case' }]);
  const result = recordSealedGateRun(board, { agentId: 'coordinator', receipt, lane: 'core' });
  assert.deepEqual(result.quarantined.map(row => row.file), ['test/flaky.test.js']);
  const [quarantined] = flakeQuarantines(board);
  assert.equal(flakeQuarantines(board).length, 1, 'only-red, only-green and pre-landing tests get no quarantine');
  assert.deepEqual([quarantined.file, quarantined.tree, quarantined.runs, quarantined.status], ['test/flaky.test.js', tree('b'), ['proven-red', 'proven-green'], 'quarantined']);
  assert.match(getItem(board, quarantined.item).item_title, /Flaky test: test\/flaky\.test\.js :: case/);
  const ratchet = landingFlakeRatchet(board);
  assert.deepEqual(ratchet.unprotected, []);
  assert.equal(ratchet.allowed, true);
  assert.deepEqual(recordSealedGateRun(board, { agentId: 'coordinator', receipt: { ...receipt, id: '00000000-0000-4000-8000-0000000000c2' }, lane: 'core' }).quarantined, [], 'an active quarantine is never filed twice');
});

/** Replay runs a move at its recorded engine: an older structured run must file nothing, so later ids stay as recorded. */
test('an old-engine recorded gate run replays through the engine without backfill; a current one backfills [C7,H16]', t => {
  for (const [engine, filed] of [[QUARANTINE_BACKFILL_ENGINE - 1, 0], [ENGINE_VERSION, 1]]) {
    const { board, receipt } = backfillFixture(t);
    const items = listItems(board, { all: true }).length, before = events(board).length;
    const move = { version: 1, engine, id: `backfill-replay-${engine}`, operation: 'recordGateRun', args: [{ agentId: 'coordinator', receipt, lane: 'core' }], actor: 'coordinator' };
    applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString() });
    assert.equal(flakeQuarantines(board).length, filed);
    assert.equal(listItems(board, { all: true }).length, items + filed, 'only the current engine adds a repair item');
    assert.deepEqual(events(board).slice(before).map(row => row.event_kind).filter(kind => ['gate-run', 'test-quarantine'].includes(kind)),
      filed ? ['gate-run', 'test-quarantine'] : ['gate-run'], 'an old move records only the run itself');
  }
});
