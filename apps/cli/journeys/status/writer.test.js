/** @pullboard-test-input SPEC.md */
/** @pullboard-test-loads packages/store/src/io/board.js apps/cli/src/io/entry.js packages/store/src/io/board/event/log.js */
/** Criterion preparation must not occupy the actual SQLite writer lease [B2,C7,V2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { boardWriteIoProblems } from '../../../../packages/gate/src/io/board/write.js';
import { styleSources } from '../../../../packages/codemap/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { afterBoardWrite } from '../../../../packages/store/src/io/board/event/log.js';

/** Set up only native fixture operations; file storage is necessary to observe the writer lock. */
function setup(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const agentId = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Prepared outside the writer',
    criterion: 'The actual fixture check passes', check: 'node apps/cli/src/io/run/tests.js apps/cli/journeys/status/writer.test.js',
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
    assert.ok(readFileSync(new URL('../../../../SPEC.md', import.meta.url), 'utf8').length > 0);
    peer.exec('BEGIN IMMEDIATE');
    try { observed.calls++; }
    finally { peer.exec('ROLLBACK'); }
    return { text: JSON.stringify({ criterion: item.item_criterion, check: item.item_check, rows: [],
      policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'prepared-lock-fixture' };
  };
}

test('registration heartbeat and nested sidecars wait for the outer commit [B2,C7]', t => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const peer = new DatabaseSync(file);
  peer.exec('PRAGMA busy_timeout=0');
  t.after(() => peer.close());
  const observed = [];
  store.atomic(board, () => {
    store.register(board, { lane: 'coordinator', path: '/new-coordinator' });
    assert.equal(existsSync(`${file}.presence.sqlite`), false, 'registration has not touched its sidecar under the outer writer');
    try {
      store.atomic(board, () => { afterBoardWrite(board, () => observed.push('rolled back')); throw new Error('cancel savepoint'); });
    } catch (error) { assert.equal(error.message, 'cancel savepoint'); }
    afterBoardWrite(board, () => {
      peer.exec('BEGIN IMMEDIATE');
      try { observed.push('released'); } finally { peer.exec('ROLLBACK'); }
    });
    assert.deepEqual(observed, []);
  });
  assert.equal(existsSync(`${file}.presence.sqlite`), true);
  assert.deepEqual(observed, ['released'], 'rolled-back callbacks never run and committed callbacks see a free writer');
});

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

test('claim preparation rechecks original guards after an intervening native hold [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const freeze = unlockedFreeze(peer, observed);
  assert.throws(() => writeBoardCommand(board, 'claim', [id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze(item) {
      const frozen = freeze(item);
      store.holdItem(board, id, { agentId: 'coordinator', reason: 'Pause during preparation' });
      return frozen;
    } }], agentId), error => error.code === 'ITEM_HELD');
  assert.equal(observed.calls, 1, 'changed hold guard runs before another source read');
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(store.events(board).filter(event => event.item_id === id && event.event_kind === 'claim').length, 0);
});

test('continuous native edits exhaust bounded preparation without a partial claim [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const freeze = unlockedFreeze(peer, observed);
  assert.throws(() => writeBoardCommand(board, 'claim', [id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze(item) {
      const frozen = freeze(item);
      store.editItem(board, id, { agentId: 'coordinator', criterion: `Native edit ${observed.calls}` });
      return frozen;
    } }], agentId), error => error.code === 'BOARD_BUSY');
  assert.equal(observed.calls, 5);
  assert.equal(store.getItem(board, id).item_status, 'open');
  assert.equal(store.events(board).filter(event => event.item_id === id && event.event_kind === 'claim').length, 0);
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
  return [{ file: 'packages/store/src/io/board/event/log.js', source: 'export function atomic(board, work) { return work(); }' },
    { file: 'src/fixture-writer.js', source }, ...extra];
}

test('the write guard follows named, aliased and reexported I/O without running source [C7,CD39]', () => {
  const cases = [
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {readFileSync as load} from 'node:fs'; atomic(board, () => load('private'));",
    "import {atomic as tx} from '../packages/store/src/io/board/event/log.js'; import fs from 'node:fs'; const io=fs; const write=() => io.readFileSync('private'); tx(board, () => write());",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import * as fs from 'node:fs'; atomic(board, () => fs['readFileSync']('private'));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import * as fs from 'node:fs'; atomic(board, () => fs[method]('private'));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {read} from './facade.js'; atomic(board, () => read());",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {execFileSync} from 'node:child_process'; const run=execFileSync; const tx=atomic; tx(board, () => run('git'));",
  ];
  const extra = [{ file: 'src/facade.js', source: "export {read} from './provider.js';" },
    { file: 'src/provider.js', source: "import {readFileSync} from 'node:fs'; export function read() { return readFileSync('private'); }" }];
  for (const source of cases) assert.ok(boardWriteIoProblems(guardSources(source, extra), { pending: {} }).length > 0, source);
  const pure = "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {join} from 'node:path'; atomic(board, () => { const text=\"readFileSync('not executed')\"; return join('a', 'b'); });";
  assert.deepEqual(boardWriteIoProblems(guardSources(pure), { pending: {} }), []);
});

test('network imports and global requests cannot run inside a board writer [B2,C7,CD39]', () => {
  const cases = [
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {request as send} from 'node:https'; atomic(board, () => send('https://invalid.test'));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import * as net from 'node:net'; atomic(board, () => net.connect(1234));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; atomic(board, () => fetch('https://invalid.test'));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; const send = globalThis.fetch; atomic(board, () => send('https://invalid.test'));",
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; atomic(board, () => new WebSocket('wss://invalid.test'));",
  ];
  for (const source of cases) assert.ok(boardWriteIoProblems(guardSources(source), { pending: {} }).length > 0, source);
  const local = "import {atomic} from '../packages/store/src/io/board/event/log.js'; function fetch() { return 'local'; } atomic(board, () => fetch());";
  assert.deepEqual(boardWriteIoProblems(guardSources(local), { pending: {} }), [], 'a known local function is not a network global');
  const address = "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {isIP} from 'node:net'; atomic(board, () => isIP('127.0.0.1'));";
  assert.deepEqual(boardWriteIoProblems(guardSources(address), { pending: {} }), [], 'pure address validation performs no network I/O');
});

test('opaque atomic callbacks are refused rather than silently certified [C7,CD39]', () => {
  const source = "import {atomic} from '../packages/store/src/io/board/event/log.js'; atomic(board, callbacks[name]);";
  assert.ok(boardWriteIoProblems(guardSources(source), { pending: {} }).some(row => row.call === 'unresolved atomic callback'));
});

test('the native write publication admits no filesystem or process call [C7,CD39]', () => {
  const source = "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {beginBoardWrite} from './board-write-lock.js'; atomic(board, () => beginBoardWrite());";
  const writer = "import {writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; export function beginBoardWrite() { writeFileSync('marker', 'owned'); execFileSync('git'); }";
  const problems = boardWriteIoProblems(guardSources(source, [{ file: 'src/board-write-lock.js', source: writer }]), { pending: {} });
  assert.ok(problems.some(row => row.call === 'node:child_process#execFileSync'));
  assert.ok(problems.some(row => row.call === 'node:fs#writeFileSync'));
});

test('the named policy witness cannot hide unrelated reads or a child process [C7,CD39]', () => {
  const policy = { file: 'apps/cli/src/io/read.js', source:
    "import {readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; function policyRefBytes() { return readFileSync('ref'); } function writePolicySignature() { policyRefBytes(); readFileSync('unrelated'); execFileSync('git'); }" };
  const problems = boardWriteIoProblems(guardSources('', [policy]));
  assert.equal(problems.filter(row => row.call === 'node:fs#readFileSync').length, 1, 'only the exact ref helper is exempt');
  assert.ok(problems.some(row => row.call === 'node:child_process#execFileSync'));
});

test('calling the hold append inside a writer exempts no I/O [C7,CD39]', () => {
  const source = "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {recordBoardHold} from './board-hold-log.js'; atomic(board, () => recordBoardHold());";
  const writer = "import {writeSync, readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; export function recordBoardHold() { writeSync(1, 'line'); readFileSync('unrelated'); execFileSync('git'); }";
  const problems = boardWriteIoProblems(guardSources(source, [{ file: 'src/board-hold-log.js', source: writer }]), { pending: {} });
  assert.ok(problems.some(row => row.call === 'node:fs#writeSync'));
  assert.ok(problems.some(row => row.call === 'node:fs#readFileSync'));
  assert.ok(problems.some(row => row.call === 'node:child_process#execFileSync'));
});

test('receipt reads are refused in every writer, including the train writer [C7,CD39]', () => {
  const receipt = { file: 'src/gate-run-receipt.js', source:
    "import {readFileSync} from 'node:fs'; export function readGateReceipt() { return readFileSync('receipt'); }" };
  const train = { file: 'src/record-train-landing.js', source:
    "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {readGateReceipt} from './gate-run-receipt.js'; export function recordTrainLanding(board) { return atomic(board, () => readGateReceipt()); }" };
  const other = "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {readGateReceipt} from './gate-run-receipt.js'; atomic(board, () => readGateReceipt());";
  const assigned = guardSources('', [receipt, train]);
  assert.ok(boardWriteIoProblems(assigned).some(row => row.call === 'node:fs#readFileSync'));
  assert.ok(boardWriteIoProblems(guardSources(other, [receipt, train])).some(row => row.call === 'node:fs#readFileSync'),
    'another transaction cannot read the receipt either');
  assert.ok(boardWriteIoProblems(assigned, { pending: {} }).some(row => row.call === 'node:fs#readFileSync'),
    'removing the named repair exposes the actual deferred read');
});

test('the transaction implementation is audited after acquisition, keeping preparation outside [C7,CD39]', () => {
  const kernel = { file: 'packages/store/src/io/board/event/log.js', source:
    "import {readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; function prepareBoardWriteIdentity() { execFileSync('ps'); } export function atomic(board, work) { prepareBoardWriteIdentity(); beginImmediateQueued(board.db); readFileSync('inside'); return work(); }" };
  const problems = boardWriteIoProblems(guardSources('', [kernel]), { pending: {} });
  assert.ok(problems.some(row => row.call === 'node:fs#readFileSync'), 'the actual wrapper is not a hidden I/O boundary');
  assert.ok(!problems.some(row => row.call === 'node:child_process#execFileSync'), 'pre-acquisition process identity work holds no SQLite writer lock');
});

test('native transaction source contains no unassigned named external I/O [C7,CD39]', () => {
  assert.deepEqual(boardWriteIoProblems(styleSources(fileURLToPath(new URL('../../../..', import.meta.url)))), []);
});

test('exact moved store writer identities preserve guard coverage and reject adjacent I/O [C7,CD39]', () => {
  for (const atomicPath of ['packages/store/src/io/board/event/log.js']) {
    const atomic = { file: atomicPath, source: 'export function atomic(board, work) { beginImmediateQueued(board.db); return work(); }' };
    const caller = { file: 'src/fixture-writer.js', source: `import {atomic} from '../${atomicPath}'; import {readFileSync} from 'node:fs'; export function write(board) { return atomic(board, () => readFileSync('bad')); }` };
    assert.ok(boardWriteIoProblems([atomic, caller], { pending: {} }).some(row => row.call === 'node:fs#readFileSync'), atomicPath);
  }
  for (const name of ['finishBoardWrite', 'finishBoardWriteAdjacent']) {
    const writer = { file: 'packages/store/src/io/board/write/lock.js', source: `import {writeSync} from 'node:fs'; export function ${name}() { writeSync(2, 'message'); }` };
    const caller = { file: 'src/fixture-writer.js', source: `import {atomic} from '../packages/store/src/io/board/event/log.js'; import {${name}} from '../packages/store/src/io/board/write/lock.js'; export function write(board) { return atomic(board, () => ${name}()); }` };
    const problems = boardWriteIoProblems(guardSources('', [writer, caller]), { pending: {} });
    assert.ok(problems.some(row => row.call === 'node:fs#writeSync'), name);
  }
  const receipt = { file: 'packages/store/src/io/receipts.js', source: "import {readFileSync} from 'node:fs'; export function proofRunReceipt() { return readFileSync('receipt'); }" };
  const caller = { file: 'src/fixture-writer.js', source: "import {atomic} from '../packages/store/src/io/board/event/log.js'; import {proofRunReceipt} from '../packages/store/src/io/receipts.js'; export function write(board) { return atomic(board, () => proofRunReceipt()); }" };
  assert.ok(boardWriteIoProblems(guardSources('', [receipt, caller])).some(row => row.call === 'node:fs#readFileSync'), 'relocation cannot exempt the receipt read');
  assert.ok(boardWriteIoProblems(guardSources('', [receipt, caller]), { pending: {} }).some(row => row.call === 'node:fs#readFileSync'), 'no pending permission means the same mapped I/O is refused');
});
