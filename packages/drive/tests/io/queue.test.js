/** A finished test run reports its verdict through --status, and a run no worker took reports a typed refusal [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { START_BOUND_MS } from '../../index.js';
import { queueTestRun } from '../../index.js';
import { readTestRun } from '../../index.js';
import { testRunLines } from '../../index.js';
import { workTestRun } from '../../index.js';

const { root } = privateFixtureFiles('run-status-finished-');
after(() => rmSync(root, { recursive: true, force: true }));

/** A queued run on a fresh board whose detached worker is a stand-in that never starts. */
function queued(t, now) {
  const board = fixtureBoard(t);
  const ctx = { info: { commonDir: root, root } };
  const run = queueTestRun(ctx, work => work(board), { agent: 'seat', files: ['test/a.test.js'] },
    { launch: () => ({ unref() {} }), now });
  return { board, run };
}

test('a run whose log ends with the worker verdict reports it, not running [C7]: the result record never landed', (t) => {
  const { board, run } = queued(t, Date.now());
  takeJob(board.db, run.id, 'test-run:1', { leaseMs: 600_000 });
  writeStep(board.db, run.id, 'running', { pid: 1 });
  assert.equal(readTestRun(board, run.id).status, 'running');
  writeFileSync(run.log, 'admitted on host\npullboard test: red on host-1 in 47s\nnext: pullboard next\n');
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'red');
  assert.equal(found.result.runner, 'host-1');
  assert.equal(found.result.seconds, 47);
  assert.match(testRunLines(found)[0], /red on host-1 in 47s/u);
});

test('a run with a recorded result reports green or red [C7]: the board record wins', async (t) => {
  const { board, run } = queued(t, Date.now());
  await workTestRun(work => work(board), run.id, async () => ({ green: true, runner: 'host-2', seconds: 3, files: ['test/a.test.js'], logPath: run.log }));
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'green');
  assert.equal(found.result.seconds, 3);
});

test('a run no worker took within the start bound reports TEST_RUN_NOT_STARTED [C7]: typed, not queued forever', (t) => {
  const { board, run } = queued(t, Date.now() - START_BOUND_MS - 1000);
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'refused');
  assert.equal(found.refusal.code, 'TEST_RUN_NOT_STARTED');
  assert.match(testRunLines(found)[0], /refused: \[TEST_RUN_NOT_STARTED\]/u);
  const fresh = queued(t, Date.now());
  assert.equal(readTestRun(fresh.board, fresh.run.id).status, 'queued');
});
