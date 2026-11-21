/** @pullboard-test-input source-cell packages/drive */
/** With runners.localWake on, an idle loopback runner claims a newly offered job within 0.5 s, not after its 2 s idle nap; off, it watches nothing and naps as before [P7,C7,#10409]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { WAKE_FILE } from '../../index.js';
import { watchWake } from '../../src/io/wake.js';
import { serveLocalRunner } from '../../index.js';
import { wakeLocalRunner } from '../../index.js';
import { testGit } from '../fixtures/git.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';

/** A loopback board that answers every claim with an empty queue; nextClaim() settles with the time of the next claim to arrive. */
function emptyBoard() {
  let waiting = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const now = Date.now();
      for (const settle of waiting.splice(0)) settle(now);
      response.setHeader('content-type', 'application/json');
      response.end('{"claim":null}');
    });
  });
  const listening = new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, listening, nextClaim: () => new Promise(resolve => waiting.push(resolve)) };
}

/** Start the real local runner, with its default 2 s idle nap, against an empty loopback board; resolves once it has made its first claim. */
async function idleRunner(t, wakeOnOffer) {
  const folder = temporaryDirectory('pullboard-local-wake-');
  const board = emptyBoard();
  const origin = `http://127.0.0.1:${await board.listening}`;
  const stop = new AbortController();
  const first = board.nextClaim();
  const open = async () => ({ origin, key: 'k', boards: () => [{ root: folder, id: 'b' }], close: async () => {} });
  const running = serveLocalRunner({ folder, open, capabilities: [], git: testGit, signal: stop.signal, wakeOnOffer, timing: { heartbeatMs: 600_000 } });
  t.after(async () => { stop.abort(); await running; board.server.close(); rmSync(folder, { recursive: true, force: true }); });
  await first;
  return { folder, board };
}

test('drive.local-wake.with-runners-localwake-on-an-idle: clause 2: with runners.localWake on, an idle loopback runner claims a newly offered job within 0.5 s of the offering command\'s touch [P7,C7,#10409]', { timeout: 30_000 }, // budget: one runner start and one wake.
  async t => {
    const { folder, board } = await idleRunner(t, true);
    const next = board.nextClaim();
    const touched = Date.now();
    assert.equal(wakeLocalRunner(folder), true, 'a live local runner has a state file, so the touch is written');
    const took = (await next) - touched;
    assert.ok(took < 500, `claimed ${took} ms after the touch`); // budget: 0.5 s declared by the bar of #10409, against the 2 s idle nap it replaces.
  });

test('drive.local-wake.with-runners-localwake-off-the-idle: clause 1: with runners.localWake off, the idle runner watches no wake file and keeps its 2 s idle nap [P7,C7,#10409]', { timeout: 30_000 }, // budget: one runner start.
  async t => {
    const { folder } = await idleRunner(t, false);
    assert.equal(existsSync(join(folder, WAKE_FILE)), false);
  });

test('drive.local-wake.a-touch-with-no-local-runner-writes-nothing: clause 1: a touch in a folder with no live local runner writes no wake file [P7,C7,#10409]', t => {
  const folder = temporaryDirectory('pullboard-local-wake-none-');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.equal(wakeLocalRunner(folder), false);
  assert.equal(existsSync(join(folder, WAKE_FILE)), false);
});

test('drive.local-wake.touch-beats-timer: clause 1: with a 60000 ms nap a touch of the wake file makes mark receive touch then wake and the nap resolve before the timer; a nap that times out marks timeout [P7,C7,#12270]', async t => {
  const folder = temporaryDirectory('pullboard-local-wake-mark-');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const marks = [];
  const wake = watchWake(folder, { mark: step => marks.push(step) });
  t.after(() => wake.close());
  const napping = wake.nap(60_000);
  writeFileSync(join(folder, WAKE_FILE), 'touch');
  await napping;
  assert.deepEqual(marks.slice(0, 2), ['touch', 'wake'], 'the touch is marked first, then the early end of the nap');
  assert.equal(marks.includes('timeout'), false, 'the 60000 ms timer did not end the nap');
  const timedOut = [];
  const idle = temporaryDirectory('pullboard-local-wake-timeout-');
  t.after(() => rmSync(idle, { recursive: true, force: true }));
  const quiet = watchWake(idle, { mark: step => timedOut.push(step) });
  t.after(() => quiet.close());
  await quiet.nap(1);
  assert.deepEqual(timedOut, ['timeout']);
});

test('drive.local-wake.touch-finds-a-runner-under-a-home: clause 1: a runner started under a PULLBOARD_HOME is found by a touch given that home and missed by a touch given none [P7,C7,#12694]', { timeout: 30_000 }, async t => {
  const folder = temporaryDirectory('pullboard-local-wake-home-');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const home = join(folder, 'home');
  const stop = new AbortController();
  const board = emptyBoard();
  const origin = `http://127.0.0.1:${await board.listening}`;
  const first = board.nextClaim();
  const open = async () => ({ origin, key: 'k', boards: () => [{ root: folder, id: 'b' }], close: async () => {} });
  const running = serveLocalRunner({ folder, open, capabilities: [], git: testGit, signal: stop.signal, wakeOnOffer: true, home, timing: { heartbeatMs: 600_000 } });
  t.after(async () => { stop.abort(); await running; board.server.close(); });
  await first;
  assert.equal(wakeLocalRunner(folder), false, 'with no home the plain state file is absent, so no runner is found');
  assert.equal(wakeLocalRunner(folder, home), true, 'with the runner\'s home its keyed state file is found and the touch is written');
});
