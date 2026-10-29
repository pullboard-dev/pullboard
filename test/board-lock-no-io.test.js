/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/board.js src/cli.js src/board-event-log.js */
/** Criterion preparation must not occupy the actual SQLite writer lease [B2,C7,V2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { writeBoardCommand } from '../src/board-command-write.js';
import { exportBoard } from '../src/exchange.js';
import { boardWriteIoProblems } from '../bin/checks/board-write-io.js';
import { styleSources } from '../src/source-inventory.js';
import { fixtureBoard } from './board-fixture.js';

/** Set up only native fixture operations; file storage is necessary to observe the writer lock. */
function setup(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const agentId = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Prepared outside the writer',
    criterion: 'The actual fixture check passes', check: 'node bin/run-tests.js test/board-lock-no-io.test.js',
    brief: 'Files: src/board.js\nTest: observes the actual private SQLite writer', route: 'strong' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const peer = new DatabaseSync(file);
  peer.exec('PRAGMA busy_timeout=0');
  t.after(() => peer.close());
  return { board, agentId, id, peer };
}

/** Prepare a real source read and prove a separate connection can acquire and release the actual lock. */
function unlockedFreeze(peer, observed) {
  return item => {
    assert.ok(readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8').length > 0);
    peer.exec('BEGIN IMMEDIATE');
    try { observed.calls++; }
    finally { peer.exec('ROLLBACK'); }
    return { text: JSON.stringify({ criterion: item.item_criterion, check: item.item_check, rows: [],
      policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'prepared-lock-fixture' };
  };
}

test('claim prepares its criterion before the real SQLite write lock [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const result = store.claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: unlockedFreeze(peer, observed) });
  assert.equal(observed.calls, 1, 'prepare the actual source once');
  assert.equal(result.renewed, false);
  assert.equal(store.getItem(board, id).item_owner, agentId);
  assert.equal(store.events(board).filter(event => event.item_id === id && event.event_kind === 'claim').length, 1);
});

test('a refused claim keeps the original guard priority before criterion preparation [B2,V2]', t => {
  const { board, agentId, id } = setup(t);
  const before = store.events(board);
  let calls = 0;
  assert.throws(() => store.claim(board, id, { agentId, lane: 'other', leaseMs: 7_200_000,
    freeze: () => { calls++; throw new Error('a wrong-lane claim must not read source'); } }),
  error => error.code === 'WRONG_LANE');
  assert.equal(calls, 0);
  assert.deepEqual(store.events(board), before);
  assert.equal(store.getItem(board, id).item_status, 'open');
});


test('the native command prepares before its enclosing writer too [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const result = writeBoardCommand(board, 'claim', [id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: unlockedFreeze(peer, observed) }], agentId);
  assert.equal(observed.calls, 1);
  assert.equal(result.renewed, false);
  assert.equal(store.getItem(board, id).item_owner, agentId);
});

test('an intervening native edit invalidates prepared source without a partial claim [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const prepared = store.prepareClaim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: unlockedFreeze(peer, observed) });
  store.editItem(board, id, { agentId: 'coordinator', criterion: 'A changed criterion needs preparation again' });
  const before = exportBoard(board);
  assert.throws(() => writeBoardCommand(board, 'claim', [id, prepared], agentId), error => error.code === 'BOARD_BUSY');
  assert.deepEqual(exportBoard(board), before, 'refusing the stale plan changes no native row or event');
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(observed.calls, 1, 'a stale binding never repeats external work while locked');
});


test('a non-claim native command retains its own arguments and domain guards [B2,C7]', t => {
  const { board, agentId, id } = setup(t);
  const result = writeBoardCommand(board, 'shout', [{ from: agentId, to: 'all', text: 'A native non-claim message' }], agentId);
  assert.ok(result);
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(store.events(board).filter(event => event.item_id === id && event.event_kind === 'claim').length, 0);
  assert.ok(store.recentShouts(board).some(row => row.shout_text === 'A native non-claim message'));
});


/** Static fixtures describe source only; the guard never imports or executes these module bodies. */
function guardSources(source, extra = []) {
  return [{ file: 'src/board-event-log.js', source: 'export function atomic(board, work) { return work(); }' },
    { file: 'src/fixture-writer.js', source }, ...extra];
}

test('the write guard follows named, aliased and reexported I/O without running source [C7,CD39]', () => {
  const cases = [
    "import {atomic} from './board-event-log.js'; import {readFileSync as load} from 'node:fs'; atomic(board, () => load('private'));",
    "import {atomic as tx} from './board-event-log.js'; import fs from 'node:fs'; const io=fs; const write=() => io.readFileSync('private'); tx(board, () => write());",
    "import {atomic} from './board-event-log.js'; import * as fs from 'node:fs'; atomic(board, () => fs['readFileSync']('private'));",
    "import {atomic} from './board-event-log.js'; import * as fs from 'node:fs'; atomic(board, () => fs[method]('private'));",
    "import {atomic} from './board-event-log.js'; import {read} from './facade.js'; atomic(board, () => read());",
    "import {atomic} from './board-event-log.js'; import {execFileSync} from 'node:child_process'; const run=execFileSync; const tx=atomic; tx(board, () => run('git'));",
  ];
  const extra = [{ file: 'src/facade.js', source: "export {read} from './provider.js';" },
    { file: 'src/provider.js', source: "import {readFileSync} from 'node:fs'; export function read() { return readFileSync('private'); }" }];
  for (const source of cases) assert.ok(boardWriteIoProblems(guardSources(source, extra), { pending: {} }).length > 0, source);
  const pure = "import {atomic} from './board-event-log.js'; import {join} from 'node:path'; atomic(board, () => { const text=\"readFileSync('not executed')\"; return join('a', 'b'); });";
  assert.deepEqual(boardWriteIoProblems(guardSources(pure), { pending: {} }), []);
});

test('opaque atomic callbacks are refused rather than silently certified [C7,CD39]', () => {
  const source = "import {atomic} from './board-event-log.js'; atomic(board, callbacks[name]);";
  assert.ok(boardWriteIoProblems(guardSources(source), { pending: {} }).some(row => row.call === 'unresolved atomic callback'));
});

test('the native write publication exception cannot hide a new process call [C7,CD39]', () => {
  const source = "import {atomic} from './board-event-log.js'; import {beginBoardWrite} from './board-write-lock.js'; atomic(board, () => beginBoardWrite());";
  const writer = "import {writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; export function beginBoardWrite() { writeFileSync('marker', 'owned'); execFileSync('git'); }";
  const problems = boardWriteIoProblems(guardSources(source, [{ file: 'src/board-write-lock.js', source: writer }]), { pending: {} });
  assert.ok(problems.some(row => row.call === 'node:child_process#execFileSync'));
  assert.ok(!problems.some(row => row.call === 'node:fs#writeFileSync'));
});

test('a named deferred receipt read is allowed only through its assigned train writer [C7,CD39]', () => {
  const receipt = { file: 'src/gate-run-receipt.js', source:
    "import {readFileSync} from 'node:fs'; export function readGateReceipt() { return readFileSync('receipt'); }" };
  const train = { file: 'src/record-train-landing.js', source:
    "import {atomic} from './board-event-log.js'; import {readGateReceipt} from './gate-run-receipt.js'; export function recordTrainLanding(board) { return atomic(board, () => readGateReceipt()); }" };
  const other = "import {atomic} from './board-event-log.js'; import {readGateReceipt} from './gate-run-receipt.js'; atomic(board, () => readGateReceipt());";
  const assigned = guardSources('', [receipt, train]);
  assert.deepEqual(boardWriteIoProblems(assigned), []);
  assert.ok(boardWriteIoProblems(guardSources(other, [receipt, train])).some(row => row.call === 'node:fs#readFileSync'),
    'a pending train repair does not waive another transaction reading the same receipt');
  assert.ok(boardWriteIoProblems(assigned, { pending: {} }).some(row => row.call === 'node:fs#readFileSync'),
    'removing the named repair exposes the actual deferred read');
});

test('native transaction source contains no unassigned named external I/O [C7,CD39]', () => {
  assert.deepEqual(boardWriteIoProblems(styleSources(fileURLToPath(new URL('..', import.meta.url)))), []);
});
