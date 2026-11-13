/** A landing holds the board only to offer its land job and record its receipt, each under a second [C7,#3333,P7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../packages/api/index.js';
import { closeCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { offerPulledLanding } from '../../src/io/landing/pull.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const SECOND_MS = 1_000;
const MAIN = 'a'.repeat(40);
const CONFIG = { trunk: { remote: '/trunk-remote-of-record.git' } };

/** A private cell board file; each step opens and closes its own connection and reports how long it held the board. */
function hostBoard(t) {
  const { root } = privateFixtureFiles('pullboard-hold-span-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'board.sqlite');
  const spans = [];
  const onBoard = async (name, work) => {
    const board = openCellBoard(file);
    const started = performance.now();
    try { return await work(board); } finally { spans.push({ name, ms: performance.now() - started }); closeCellBoard(board); }
  };
  const jobs = board => board.db.prepare('SELECT COUNT(*) AS n FROM job').get().n;
  return { onBoard, spans, jobs };
}

test('clause 1: a landing with nothing accepted offers no land job and writes no job row [C7,#3333,P7]', async t => {
  const host = hostBoard(t);
  const said = [];
  const reads = { mainPolicy: () => ({ config: CONFIG, commit: MAIN }), listItems: () => [], checkedLandingCommit: () => { throw new Error('nothing is accepted'); } };
  const result = await host.onBoard('offer', board => offerPulledLanding({ io: { say: line => said.push(line) } }, '/unused', reads, { board }));
  assert.deepEqual(result, { offered: null, items: [], waiting: false });
  assert.equal(await host.onBoard('count', board => host.jobs(board)), 0, 'with nothing accepted, the landing writes no job row');
  assert.deepEqual(said, []);
  assert.deepEqual(host.spans.filter(span => span.ms >= SECOND_MS), [], 'no board hold reaches a second');
});

test('clause 1: a real landing opens the board only to offer its job and record its receipt, each under a second [C7,#3333,P7]', async t => {
  const host = hostBoard(t);
  const items = [{ id: 1, commit: 'b'.repeat(40), ref: 'refs/pullboard/land/1' }];
  const offered = await host.onBoard('offer', board => offerLandingJob(board.db, { items, expect: MAIN, config: CONFIG, now: 1 }));
  assert.equal(offered.kind, 'land');
  const call = (name, body) => host.onBoard(name, board => jobQueueCall(board.db, body, { mode: 'pull', now: 2 }));
  const { claim } = await call('claim', { action: 'claim', runner: 'runner-far', kinds: ['land'] });
  assert.equal(claim?.job ?? claim?.id, offered.id, 'a runner takes the offered land job');
  const receipt = { kind: 'land', outcome: 'landed', expect: MAIN, base: MAIN, trunk: 'c'.repeat(40), landed: [1], already: [], attempts: 1, moved: [], detail: null };
  const posted = await call('receipt', { action: 'receipt', job: offered.id, runner: 'runner-far', token: claim.token, receipt });
  assert.equal(posted.recorded, true, 'the board records the runner\'s receipt');
  assert.deepEqual(host.spans.map(span => span.name), ['offer', 'claim', 'receipt'], 'the board host opens only to offer, hand out and record; the runner does every landing step');
  assert.deepEqual(host.spans.filter(span => span.ms >= SECOND_MS), [], 'no board hold of a landing reaches a second');
});
