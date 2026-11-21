/** next hands a seat its finished test runs without queueing for the board writer [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../packages/board/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../../../packages/store/tests/fixtures/tmp.js';
import { readTestRun } from '../../../../../packages/drive/index.js';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { workTestRun } from '../../../../../packages/drive/index.js';
import { deliverSeatRuns } from '../../../src/io/commands/next.js';

const BUDGET_MS = 200;
const SEAT = 'seat';

/** A file board whose folder the test removes, and the connection a verify or submit would hold the writer with. */
function boardFile(t) {
  const directory = temporaryDirectory('pullboard-next-delivery-');
  const file = join(directory, 'board.sqlite');
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking', file });
  const holder = new DatabaseSync(file);
  t.after(() => { try { holder.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { board, file, holder, directory };
}

/** Finish a queued run with a recorded result: green, so next prints it and marks it delivered. */
async function finished(board, directory, agent) {
  const files = ['test/a.test.js'];
  const run = queueTestRun({ info: { commonDir: directory, root: directory } }, work => work(board), { agent, files }, { launch: () => ({ unref() {} }) });
  await workTestRun(work => work(board), run.id, async () => ({ green: true, runner: 'host-1', seconds: 1, files }));
  return run;
}

/** Run next's delivery step against the board and report its printed lines and how long it took. */
function deliver(board, file) {
  const lines = [];
  const ctx = { file, info: { root: file } };
  const services = { withBoard: (_ctx, work) => work(board), withBoardRead: (_ctx, work) => work(board), whoAmI: () => ({ id: SEAT }) };
  const started = performance.now();
  const result = deliverSeatRuns({ say: line => lines.push(line) }, ctx, services);
  return { lines, result, ms: performance.now() - started };
}

test('cli.io-next-delivery.skips-busy-writer: clause 1: while another connection holds the board writer, next prints the finished run and returns without waiting, leaving it undelivered [C7]', async (t) => {
  const { board, file, holder, directory } = boardFile(t);
  const run = await finished(board, directory, SEAT);
  holder.exec('BEGIN IMMEDIATE');
  const { lines, result, ms } = deliver(board, file);
  holder.exec('ROLLBACK');
  assert.ok(ms < BUDGET_MS, `delivery took ${ms} ms`);
  assert.equal(result.delivered, 1);
  assert.ok(lines.length > 0, 'the run\'s lines are printed');
  assert.equal(readTestRun(board, run.id).status, 'green');
  assert.equal(deliver(board, file).result.delivered, 1, 'the run is still undelivered, so the next call reports it again');
});

test('cli.io-next-delivery.marks-when-writer-free: clause 2: with the writer free the run is printed and marked delivered once, and a second delivery prints nothing [C7]', async (t) => {
  const { board, file, directory } = boardFile(t);
  await finished(board, directory, SEAT);
  const first = deliver(board, file);
  assert.equal(first.result.delivered, 1);
  assert.ok(first.lines.length > 0);
  const second = deliver(board, file);
  assert.equal(second.result.delivered, 0);
  assert.deepEqual(second.lines, []);
});

test('cli.io-next-delivery.cost-flat-with-run-history: clause 3: with 3,105 finished undelivered runs of other seats and the writer held, the delivery step stays under 200 ms [C7]', async (t) => {
  const { board, file, holder, directory } = boardFile(t);
  for (let index = 0; index < 3105; index += 1) await finished(board, directory, `other-${index}`);
  await finished(board, directory, SEAT);
  holder.exec('BEGIN IMMEDIATE');
  const { result, ms } = deliver(board, file);
  holder.exec('ROLLBACK');
  assert.ok(ms < BUDGET_MS, `delivery took ${ms} ms`);
  assert.equal(result.delivered, 1);
});
