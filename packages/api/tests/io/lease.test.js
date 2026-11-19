/** Only the runner holding a job's lease token can post its receipt; the board key alone is refused [P7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fetchFresh } from '../../../sync/tests/fixtures/http.js';
import { jobView } from '../../../jobs/index.js';
import { Refused } from '../../../kernel/index.js';
import { createApiHandler } from '../../index.js';
import { jobQueueCall } from '../../index.js';
import { offerJob } from '../../index.js';

const KEY = 'fixture-board-key-0123456789';

test('api.lease.receipt-posted-board-key-but: clause 1: a receipt posted with the board key but not the job\'s lease token is refused, and the holder\'s is recorded [P7]', async t => {
  const { root } = privateFixtureFiles('pullboard-jobs-lease-');
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  offerJob(db, { id: 'gate:lease', kind: 'gate', needs: ['node22'] });
  // As off loopback: every call must carry the board key, as `pullboard serve` requires on the network.
  const handler = createApiHandler({ refusalDocument: error => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    authenticate: request => { if (request.headers['x-pullboard-key'] !== KEY) throw new Refused('UNAUTHORIZED', 'send the board key'); return { local: false }; },
    board: id => ({ id }), jobs: (_board, body) => jobQueueCall(db, body, { mode: 'pull' }) });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const jobs = async (body, key = KEY) => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-pullboard-key': key } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, document: await response.json() };
  };

  const { claim } = (await jobs({ action: 'claim', runner: 'r-holder', capabilities: ['node22'] })).document;
  assert.equal(claim.job, 'gate:lease');
  const green = { status: 0, gate: { green: true } };
  for (const [why, body] of [
    ['no token', { action: 'receipt', job: 'gate:lease', runner: 'r-holder', receipt: green }],
    ['the board key as the token', { action: 'receipt', job: 'gate:lease', runner: 'r-holder', token: KEY, receipt: green }],
    ['another runner with the holder\'s token', { action: 'receipt', job: 'gate:lease', runner: 'r-other', token: claim.token, receipt: green }],
    ['a token from no claim', { action: 'receipt', job: 'gate:lease', runner: 'r-holder', token: 'x'.repeat(32), receipt: green }],
  ]) {
    const refused = await jobs(body);
    assert.equal(refused.document.error?.code, 'JOB_LEASE_MOVED', `${why} is refused`);
    assert.notEqual(refused.status, 200);
  }
  assert.equal((await jobs({ action: 'receipt', job: 'gate:lease', runner: 'r-holder', token: claim.token, receipt: green }, null)).document.error?.code, 'UNAUTHORIZED', 'and the token alone needs the key too');
  assert.equal(jobView(db, 'gate:lease').step, 'claimed', 'no refused post recorded a receipt');

  const posted = await jobs({ action: 'receipt', job: 'gate:lease', runner: 'r-holder', token: claim.token, receipt: green });
  assert.deepEqual([posted.status, posted.document.recorded], [200, true]);
  assert.equal(jobView(db, 'gate:lease').step, 'done');
});
