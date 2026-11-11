/** The in-process relay the client fixture starts keeps the relay's own production poll [H5,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../packages/state/index.js';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';

const PRODUCTION_POLL_MS = 200;
const WINDOW_MS = 2_000;

/**
 * Count the fixture relay's authenticated stream polls while one live event stream stays open for a fixed window.
 * Each poll authenticates the stream's reader again, so the count follows the poll interval: about 200 in two seconds
 * at a 10 ms poll, about 10 at the relay's 200 ms (#979).
 */
async function streamPolls(box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const controller = new AbortController();
  const response = await fetch(`${box.origin}/api/v1/boards/${state.board}/events`, {
    headers: { authorization: `Bearer ${state.token}`, accept: 'text/event-stream', 'x-pullboard-engine': String(ENGINE_VERSION) },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, 'the linked board opens a live event stream');
  const reader = response.body.getReader();
  const draining = (async () => { try { while (!(await reader.read()).done); } catch { /* The window closes the stream. */ } })();
  const authenticate = box.auth.authenticate;
  let polls = 0;
  box.auth.authenticate = function countedAuthenticate(...args) { polls += 1; return authenticate.apply(this, args); };
  try {
    // budget: fixed observation window for counting the relay's own poll cadence; no throughput claim.
    await new Promise(resolve => setTimeout(resolve, WINDOW_MS));
  } finally {
    box.auth.authenticate = authenticate;
    controller.abort();
    await draining;
  }
  return polls;
}

test("the relay client fixture polls at the relay's production interval by default [H5,C7]", async t => {
  const box = await relayDirectFixture(t);
  await box.link();
  const polls = await streamPolls(box);
  const ceiling = Math.ceil(WINDOW_MS / PRODUCTION_POLL_MS) + 3;
  assert.ok(polls >= 1, `the open stream is polled at all (${polls} polls in ${WINDOW_MS} ms)`);
  assert.ok(polls <= ceiling, `the open stream is polled at most every ${PRODUCTION_POLL_MS} ms: ${polls} polls in ${WINDOW_MS} ms, at most ${ceiling}`);
});

test('a relay client fixture case can ask for a faster poll by name [H5,C7]', async t => {
  const box = await relayDirectFixture(t, { pollMs: 20 });
  await box.link();
  const polls = await streamPolls(box);
  assert.ok(polls > Math.ceil(WINDOW_MS / PRODUCTION_POLL_MS) + 3, `a 20 ms poll asked for by name polls faster than the default: ${polls} polls in ${WINDOW_MS} ms`);
});
