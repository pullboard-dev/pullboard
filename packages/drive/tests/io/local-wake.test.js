/** @pullboard-test-input source-cell packages/drive */
/** With runners.localWake on, an idle loopback runner claims a newly offered job within 0.5 s, not after its 2 s idle nap; off, it watches nothing and naps as before [P7,C7,#10409]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { WAKE_FILE } from '../../index.js';
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
