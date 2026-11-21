/** A seat with board.url set posts its heartbeat through POST /moves and reports a refusal as not held [P7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runRemoteMove } from '../../../src/io/remote/moves.js';
import { sendRemoteHeartbeat } from '../../../src/io/remote/moves.js';

test('cli.io-remote-moves.heartbeat-posts-the-move: sendRemoteHeartbeat posts {verb: heartbeat, args: {}, agent} to the fixture server /moves and reports a refusal as not held [P7,B3]', async (t) => {
  const posts = [];
  let refuse = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      posts.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(refuse ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(refuse ? { error: { code: 'NOT_HELD', message: 'this seat holds no claim' } } : { result: {} }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const remote = { url: `http://127.0.0.1:${server.address().port}/api/v1/boards/b1`, token: 'k', agent: 'core-9' };
  assert.equal(await sendRemoteHeartbeat(remote), true);
  assert.deepEqual(posts, [{ path: '/api/v1/boards/b1/moves', body: { verb: 'heartbeat', args: {}, agent: 'core-9' } }]);
  refuse = true;
  assert.equal(await sendRemoteHeartbeat(remote), false, 'a refused beat reads as not held');
});

/**
 * A fixture board host answering /moves, a clone folder and the injected beater launch, for the cases that run runRemoteMove directly.
 * Why: the launch is injected (startClaimBeater takes { launch }), so no detached beater starts and the case reads what would have launched [P7,B3].
 */
async function beaterRig(t) {
  const answers = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer = answers.shift() ?? { status: 200, body: { result: {} } };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const clone = privateFixtureFiles('beater-rig-').root;
  t.after(() => { server.close(); rmSync(clone, { recursive: true, force: true }); });
  const previous = process.env.PULLBOARD_AGENT;
  process.env.PULLBOARD_AGENT = 'core-9';
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_AGENT; else process.env.PULLBOARD_AGENT = previous; });
  const remote = { url: `http://127.0.0.1:${server.address().port}/api/v1/boards/b1`, token: 'k' };
  const launches = [];
  const options = { env: { get: (name) => (name === 'PULLBOARD_CLAIM_BEATER' ? '1' : undefined), all: () => ({ PULLBOARD_CLAIM_BEATER: '1' }) }, session: () => ({ pid: process.pid, start: null }), launch: (entry, spec) => { launches.push(spec); return 4242; } };
  const io = { cwd: clone, say() {}, err() {}, result() {}, refusal() {}, async prepareRefusal() {}, refusalDocument: () => ({ error: { next: 'none' } }), exitCode: (code) => code, flush() {} };
  const run = (verb, ...rest) => runRemoteMove(io, { positionals: [verb, ...rest], values: {} }, remote, options);
  const locks = () => { try { return readdirSync(join(clone, '.git', 'pullboard', 'beaters')); } catch { return []; } };
  return { answers, launches, run, locks };
}

test('cli.io-remote-moves.claim-starts-beater: a remote claim the fixture server accepts launches the claim beater once with the remote binding, and a refused claim launches none [P7,B3]', async (t) => {
  const rig = await beaterRig(t);
  rig.answers.push({ status: 409, body: { error: { code: 'ONE_CLAIM', message: 'this seat already holds a claim' } } });
  assert.equal(await rig.run('claim', '5'), 1, 'the refused claim exits non-zero');
  assert.deepEqual(rig.launches, [], 'a refused claim launches no beater');
  assert.deepEqual(rig.locks(), []);
  rig.answers.push({ status: 200, body: { result: { item: { item_id: 5, item_title: 'Remote item' } } } });
  assert.equal(await rig.run('claim', '5'), 0);
  assert.equal(rig.launches.length, 1, 'the accepted claim launches the beater once');
  const spec = JSON.parse(rig.launches[0].args[0]);
  assert.equal(spec.seat, 'core-9');
  assert.match(spec.remote.url, /\/api\/v1\/boards\/b1$/u);
  assert.deepEqual({ ...spec.remote, url: 'u' }, { url: 'u', token: 'k', agent: 'core-9', seatKey: null });
  assert.equal(rig.locks().length, 1, 'the beater lock names the running beater');
});

test('cli.io-remote-moves.submit-stops-beater: a following remote submit or release that succeeds removes the beater lock [P7,B3]', async (t) => {
  const rig = await beaterRig(t);
  for (const verb of ['submit', 'release']) {
    rig.answers.push({ status: 200, body: { result: { item: { item_id: 5, item_title: 'Remote item' } } } });
    assert.equal(await rig.run('claim', '5'), 0);
    assert.equal(rig.locks().length, 1, `the beater runs before ${verb}`);
    rig.answers.push({ status: 200, body: { result: { item: { item_id: 5, item_title: 'Remote item' } } } });
    assert.equal(await rig.run(verb, '5'), 0);
    assert.deepEqual(rig.locks(), [], `a successful ${verb} removes the beater lock`);
  }
  assert.equal(rig.launches.length, 2, 'only the claims launched a beater');
});
