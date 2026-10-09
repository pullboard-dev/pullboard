/** Background check baseline completions are authorized and replay as deterministic board moves [V2,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';

const MAIN = 'a'.repeat(40);
const ADD_AT = '2026-10-08T20:00:00.000Z';
const RESULT_AT = '2026-10-08T20:00:01.000Z';

/** Build a valid pending request whose identity is stable across replicas. */
function pendingBaseline(command, request = randomUUID(), main = MAIN) {
  return { command, main, result: 'pending', request };
}

/** Open an in-memory board and register it for node:test cleanup. */
function memoryBoard(t) {
  const board = store.openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  return board;
}

/** Create three real SQLite boards with the same exported starting rows. */
function boardReplicas(t) {
  const source = memoryBoard(t);
  const replicas = [memoryBoard(t), memoryBoard(t)];
  const initial = exportBoard(source);
  for (const board of replicas) importBoard(board, initial);
  return { source, replicas };
}

/** Make a harmless shell command that would leave a marker if any replica executed it. */
function markerCommand(marker) {
  /** Quote the synthetic marker command's literals for a POSIX shell. */
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

/** Apply one immutable captured operation to each board at the same relay sequence and time. */
function applyToEach(boards, move, sequence, at) {
  return boards.map((board) => applyEngineMove(board, move, { sequence, at }));
}

test('[V2,H16] a captured pending baseline completes once and replays without executing its command', (t) => {
  assert.ok(ENGINE_VERSION >= 2, 'completeCheckBaseline is a released engine operation');
  const { source, replicas } = boardReplicas(t);
  const marker = join(tmpdir(), `pullboard-baseline-must-not-run-${randomUUID()}`);
  t.after(() => rmSync(marker, { force: true }));
  const command = markerCommand(marker);
  const pending = pendingBaseline(command, '11111111-1111-4111-8111-111111111111');
  const boards = [source, ...replicas];

  const add = prepareEngineMove(source, 'addItem', [{
    by: 'coordinator', lane: 'web', title: 'Background baseline',
    check: command, checkBaseline: pending,
  }], { id: 'baseline-worker-add' });
  const added = applyToEach(boards, add, 1, ADD_AT);
  assert.ok(added.every((outcome) => outcome.result === 1));
  const itemId = added[0].result;
  assert.ok(boards.every((board) => store.getItem(board, itemId).item_check_baseline.result === 'pending'));
  assert.equal(existsSync(marker), false, 'recording the requested command does not run it');

  const baseline = { command, main: pending.main, result: 'green' };
  const completion = prepareEngineMove(source, 'completeCheckBaseline', [itemId, {
    agentId: 'coordinator', expected: pending, baseline,
  }], { id: 'baseline-worker-result' });
  const completed = applyToEach(boards, completion, 2, RESULT_AT);
  assert.ok(completed.every((outcome) => outcome.result === true));
  assert.ok(boards.every((board) => {
    const current = store.getItem(board, itemId).item_check_baseline;
    return current.command === command && current.main === MAIN && current.result === 'green'
      && current.request === pending.request && current.warning === 'CRITERION_PROVES_NOTHING';
  }));
  assert.ok(boards.every((board) => store.events(board, { itemId }).filter((event) => event.event_kind === 'check-baseline').length === 1));
  assert.deepEqual(exportBoard(source), exportBoard(replicas[0]));
  assert.deepEqual(exportBoard(source), exportBoard(replicas[1]));
  assert.equal(existsSync(marker), false, 'the completion move stores the result without executing the check');
});

test('[V2,H16] stale requests, cleared checks and duplicate terminal results cannot overwrite a baseline', (t) => {
  const board = memoryBoard(t);
  const commandA = 'check-a';
  const commandB = 'check-b';
  const first = pendingBaseline(commandA, '22222222-2222-4222-8222-222222222222');
  const itemId = store.addItem(board, {
    by: 'coordinator', lane: 'web', title: 'Superseded baseline',
    check: commandA, checkBaseline: first,
  });
  const second = pendingBaseline(commandB, '33333333-3333-4333-8333-333333333333');
  store.editItem(board, itemId, { agentId: 'coordinator', check: commandB, checkBaseline: second });
  const third = pendingBaseline(commandA, '44444444-4444-4444-8444-444444444444');
  store.editItem(board, itemId, { agentId: 'coordinator', check: commandA, checkBaseline: third });
  const beforeOldResult = exportBoard(board);
  const stale = store.completeCheckBaseline(board, itemId, {
    agentId: 'coordinator', expected: first,
    baseline: { command: commandA, main: MAIN, result: 'green' },
  });
  assert.equal(stale, false, 'A→B→A still rejects A’s old request id');
  assert.deepEqual(exportBoard(board), beforeOldResult, 'stale completion creates neither metadata nor an event');

  store.editItem(board, itemId, { agentId: 'coordinator', check: '' });
  const afterClear = exportBoard(board);
  assert.equal(store.completeCheckBaseline(board, itemId, {
    agentId: 'coordinator', expected: third,
    baseline: { command: commandA, main: MAIN, result: 'red' },
  }), false, 'a cleared check no longer has a pending request');
  assert.deepEqual(exportBoard(board), afterClear, 'a late result cannot restore cleared baseline metadata');
  assert.equal(Object.hasOwn(store.getItem(board, itemId), 'item_check_baseline'), false);

  const fourth = pendingBaseline('check-final', '55555555-5555-4555-8555-555555555555');
  store.editItem(board, itemId, { agentId: 'coordinator', check: fourth.command, checkBaseline: fourth });
  const result = { command: fourth.command, main: MAIN, result: 'red' };
  assert.equal(store.completeCheckBaseline(board, itemId, { agentId: 'coordinator', expected: fourth, baseline: result }), true);
  const afterTerminal = exportBoard(board);
  const eventCount = store.events(board, { itemId }).length;
  assert.equal(store.completeCheckBaseline(board, itemId, { agentId: 'coordinator', expected: fourth, baseline: result }), false,
    'a duplicate completion cannot replace a terminal result');
  assert.deepEqual(exportBoard(board), afterTerminal);
  assert.equal(store.events(board, { itemId }).length, eventCount);
});

test('[V2,H16] only the coordinator can set or complete a check baseline and invalid results leave no writes', (t) => {
  const board = memoryBoard(t);
  const pending = pendingBaseline('true', '66666666-6666-4666-8666-666666666666');
  const before = exportBoard(board);
  assert.throws(() => store.addItem(board, {
    by: 'web-1', lane: 'web', title: 'Agent supplied baseline', check: pending.command, checkBaseline: pending,
  }), { code: 'COORDINATOR_CHECK' });
  assert.deepEqual(exportBoard(board), before, 'an unauthorized pending baseline adds no item or event');

  const ordinaryId = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Ordinary item', check: pending.command });
  const beforeUnauthorizedEdit = exportBoard(board);
  assert.throws(() => store.editItem(board, ordinaryId, {
    agentId: 'web-1', check: pending.command, checkBaseline: pending,
  }), { code: 'COORDINATOR_CHECK' });
  assert.deepEqual(exportBoard(board), beforeUnauthorizedEdit, 'an unauthorized edit stores no pending baseline');

  const itemId = store.addItem(board, {
    by: 'coordinator', lane: 'web', title: 'Authorized pending baseline',
    check: pending.command, checkBaseline: pending,
  });
  const beforeBadCompletion = exportBoard(board);
  assert.throws(() => store.completeCheckBaseline(board, itemId, {
    agentId: 'web-1', expected: pending, baseline: { command: pending.command, main: MAIN, result: 'green' },
  }), { code: 'COORDINATOR_CHECK' });
  assert.deepEqual(exportBoard(board), beforeBadCompletion, 'an unauthorized completion changes no rows');
  assert.throws(() => store.completeCheckBaseline(board, itemId, {
    agentId: 'coordinator', expected: pending, baseline: { command: pending.command, main: MAIN, result: 'orange' },
  }), { code: 'BAD_CHECK_BASELINE' });
  assert.deepEqual(exportBoard(board), beforeBadCompletion, 'an invalid result changes no rows');
});
