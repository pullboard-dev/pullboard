/** Empty landings preserve history without bypassing an existing landing owner [E25,E26,B3]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from "../../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../../packages/store/tests/fixtures/cell.js";
import { createE2eHelpers } from "../../../tests/fixtures/e2e.js";
import { startFixtureChild } from "../../../tests/fixtures/child.js";

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Use production board functions only within this test's private fixture. */
function onBoard(box, work) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { store.closeBoard(board); }
}

test('an idle empty land takes no lease and writes no event [E25,E26,B3]', () => {
  const box = helpers.project('true');
  const before = onBoard(box, board => ({ events: store.events(board), lease: store.landingLeaseState(board) }));
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).landed, []);
  assert.deepEqual(onBoard(box, board => ({ events: store.events(board), lease: store.landingLeaseState(board) })), before,
    'neither an admission generation nor any board event changes');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(onBoard(box, board => store.landingBatches(board).length), 0);
  const adopted = box.run(box.repo, 'land', '--adopt', '--json');
  assert.equal(adopted.code, 1, 'an explicit adoption is not a successful empty landing');
  assert.equal(JSON.parse(adopted.out).error.code, 'LAND_ADOPT');
});

test('an empty land still queues behind a live landing owner [E25,B3]', async t => {
  const box = helpers.project('true');
  const token = randomUUID();
  const held = onBoard(box, board => store.landingLeaseMove(board,
    { agentId: 'coordinator', action: 'request', token, branch: 'main', pid: process.pid }));
  const release = () => onBoard(box, board => store.landingLeaseMove(board,
    { agentId: 'coordinator', action: 'release', token, generation: held.generation }));
  const child = startFixtureChild(process.execPath, [helpers.BIN, 'land'],
    { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = new Promise(resolveClose => child.once('close', code => resolveClose(code)));
  t.after(async () => {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  await helpers.waitFor(() => /landing waiting:/u.test(stdout + stderr), 'the empty land to name its live holder');
  assert.equal(child.exitCode, null, 'an empty selection cannot bypass an occupied landing lease');
  const queued = onBoard(box, board => store.landingLeaseState(board));
  assert.equal(queued.holder.token, token);
  assert.equal(queued.line.length, 1);
  release();
  assert.equal(await closed, 0, stderr);
  assert.match(stdout, /no verified items ready to land/u);
  const finished = onBoard(box, board => store.landingLeaseState(board));
  assert.equal(finished.holder, null);
  assert.deepEqual(finished.line, []);
  assert.equal(finished.generation, held.generation + 1, 'the waiter really acquired its own admission');
});
