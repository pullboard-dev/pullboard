/** Board hold percentiles read the every-write log when it exists and mark the holds-log fallback as over-a-second only [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
import { boardHoldPercentiles } from '../../../../src/io/board/hold/log.js';
import * as store from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { temporaryRepository } from '../../../fixtures/submit.js';

/** Run a body with the machine home pointed at a fresh directory, then restore it. */
function withHome(t, body) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const savedAll = process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  const home = join(cellProject(t).repo, 'percentile-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  delete process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    if (savedAll !== undefined) process.env.PULLBOARD_BOARD_HOLD_LOG_ALL = savedAll;
  });
  body(home);
}
const NOW = Date.parse('2026-11-18T12:00:00Z');
const rows = (heldList, boardFile) => heldList.map((heldMs, i) => JSON.stringify({ version: 1, at: new Date(NOW - 60_000 - i).toISOString(), command: 'c', seat: 's', heldMs, boardFile })).join('\n') + '\n';

test('store.hold.percentiles-every-write: clause 1: the median counts every write in board-writes.jsonl and names the log it read [C7]', t => withHome(t, home => {
  writeFileSync(join(home, 'board-writes.jsonl'), rows([10, 20, 30, 40, 5000]));
  writeFileSync(join(home, 'board-holds.jsonl'), rows([5000, 6000]));
  const result = boardHoldPercentiles({ until: NOW });
  assert.equal(result.count, 5);
  assert.equal(result.medianMs, 30);
  assert.equal(result.source, 'every-write');
  assert.equal(result.log, join(home, 'board-writes.jsonl'));
  assert.equal(result.overSecondOnly, false);
  writeFileSync(join(home, 'board-writes.jsonl'), rows([10, 20], '/a/board.db') + rows([900, 900], '/b/board.db'));
  assert.equal(boardHoldPercentiles({ until: NOW, boardFile: '/a/board.db' }).count, 2);
}));

test('store.hold.percentiles-fallback-marked: clause 2: with no every-write log it reads board-holds.jsonl and marks the result over-a-second only [C7]', t => withHome(t, home => {
  writeFileSync(join(home, 'board-holds.jsonl'), rows([1300, 1500, 2500]));
  const result = boardHoldPercentiles({ until: NOW });
  assert.equal(result.source, 'over-a-second');
  assert.equal(result.log, join(home, 'board-holds.jsonl'));
  assert.equal(result.overSecondOnly, true);
  assert.equal(result.medianMs, 1500);
}));

/** Sleep the thread, as a slow part of a move does on a loaded machine. */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SLOW_MS = 80;
const COMMIT = 'a'.repeat(40);
const POLICY = { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' };

/** A real board in a policy repository, with every board write logged to a fresh machine home. */
function loggedBoard(t) {
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, all: process.env.PULLBOARD_BOARD_HOLD_LOG_ALL };
  t.after(() => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['PULLBOARD_BOARD_HOLD_LOG_ALL', saved.all]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const repo = temporaryRepository(t, 'pullboard-hold-step-');
  const home = join(repo, 'hold-home');
  mkdirSync(home);
  mkdirSync(join(repo, '.git', 'pullboard'));
  process.env.PULLBOARD_MACHINE_HOME = home;
  process.env.PULLBOARD_BOARD_HOLD_LOG_ALL = '1';
  const board = cellBoard(t, join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date() }, { real: true, gitRoot: repo });
  store.board_ensureCoordinator(board, repo);
  const holds = move => readFileSync(join(home, 'board-holds.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.move === move);
  return { board, repo, holds };
}

/** Make every statement whose text and call stack match all of the patterns take SLOW_MS; returns the undo. */
function slowStatements(board, frames) {
  const own = Object.getOwnPropertyDescriptor(board.db, 'prepare');
  const prepare = board.db.prepare.bind(board.db);
  Error.stackTraceLimit = 80;
  board.db.prepare = sql => {
    const seen = `${sql}\n${new Error().stack}`;
    if (frames.every(frame => frame.test(seen))) sleep(SLOW_MS);
    return prepare(sql);
  };
  return () => { if (own) Object.defineProperty(board.db, 'prepare', own); else delete board.db.prepare; };
}

const landed = (f, title) => {
  const id = cellItem(f.board, { lane: 'core', title, criterion: '1. It works [test]', route: 'mid', brief: 'Files: src/a.js\nTest: proves it', check: 'true' }).item_id;
  store.writeBoardCommand(f.board, 'merged', [id, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'test fixture' }], 'coordinator');
  return f.holds('merged').at(-1);
};

test('store.io-board-hold-log.merged-names-slowest-step: clause 1: a merged move whose record or one logEvent hook is slow logs that part as the hold row step, not null [C7,#12605]', t => {
  const f = loggedBoard(t);
  cellSeat(f.board, { lane: 'core', path: '/builder', family: 'Prepared Builder Vendor', route: 'mid' });
  assert.equal(landed(f, 'Warm the counters').phase, 'native-move');
  const cases = [
    ['merged-record', [/item_merged_commit/u, /at setItem /u]],
    ['appendProofCounter', [/at appendProofCounter /u]],
    ['liftSettledHolds', [/at liftSettledHolds /u]],
    ['notifyUnblocked', [/at notifyUnblocked /u]],
  ];
  for (const [step, frames] of cases) {
    const undo = slowStatements(f.board, frames);
    if (step === 'liftSettledHolds') f.board.liftSettledHolds = true;
    let row;
    try { row = landed(f, `Slow ${step}`); } finally { undo(); delete f.board.liftSettledHolds; }
    assert.equal(row.step, step, `the ${step} hold row names its step`);
    assert.ok(row.stepMs >= SLOW_MS / 2, `${step} step took ${row.stepMs} ms`);
    assert.equal(row.move, 'merged');
  }
});

test('store.io-board-hold-log.submit-names-slowest-step: clause 2: a submit move whose file-miss part is slow logs that part as the hold row step, not null [C7,#12605]', t => {
  const f = loggedBoard(t);
  const builder = cellSeat(f.board, { lane: 'core', path: '/builder', family: 'Prepared Builder Vendor', route: 'mid' });
  const id = cellItem(f.board, { lane: 'core', title: 'Slow submit', criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: POLICY }), digest: 'digest:slow-submit' });
  store.claim(f.board, id, { agentId: builder.id, lane: 'core', leaseMs: 7_200_000, freeze });
  Object.defineProperty(f.board, 'fileLease', { configurable: true, get() { sleep(SLOW_MS); return undefined; } });
  store.writeBoardCommand(f.board, 'submit', [id, { agentId: builder.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }], builder.id);
  const row = f.holds('submit').at(-1);
  assert.equal(row.phase, 'native-move');
  assert.equal(row.step, 'submit-file-miss');
  assert.ok(row.stepMs >= SLOW_MS / 2, `the step took ${row.stepMs} ms`);
});
