/** A runner whose board API restarts retries at most every 4 s, so it claims work again within 4 s of the board answering (#6390) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

test('drive.reconnect.c-6390-clauses-1-2-after: #6390 clauses 1-2: after 8 failed calls the waits double from 1 s and stop at 4 s, and the first call after the board answers is a claim with no wait [C7]', async () => {
  let calls = 0, answeredAt = null;
  const events = [];
  const stop = new AbortController();
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    calls += 1;
    if (calls <= 8) throw new TypeError('fetch failed');
    events.push(`call:${call.action}`);
    answeredAt ??= events.length;
    stop.abort();
    return { status: 200, json: async () => ({ trunk: 'unused', claim: null }) };
  };
  const sleep = async ms => { events.push(`wait:${ms}`); };
  const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-reconnect', capabilities: [], cache: '/nonexistent/pullboard-reconnect', jobs: 1, cores: 2, signal: stop.signal, fetchImpl, sleep, timing: { idleMs: 1 }, trunkPack: async () => {} });
  assert.deepEqual(served.waits.slice(0, 8), [1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]);
  assert.ok(served.waits.every(ms => ms <= 4000), `a wait passed 4 s: ${served.waits}`);
  assert.equal(events[0], 'wait:1000');
  assert.equal(events[answeredAt - 1], 'call:claim', 'the board answered a claim');
  assert.ok(!events[answeredAt - 2]?.startsWith('call:'), 'no call came between the last wait and the answered claim');
});
