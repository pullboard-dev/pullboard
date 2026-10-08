/** Exercise the relay browser's SSE retry and queue lifecycle without launching Chrome [H16,H3,H5,H15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueStream, followStream } from '../relay/browser-stream.js';

/** Build a finite standards-shaped stream response for a deterministic transport probe. */
function eventResponse(id) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: ' + id + '\ndata: {"version":1,"event":{"event_id":' + id + '}}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Resolve one event-loop turn while a test aborts a blocked stream. */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

test('clean SSE EOF reconnects after a bounded delay and resumes from the delivered cursor [H16,H3]', async () => {
  const controller = new AbortController();
  const requests = [];
  const cursor = { value: 0 };
  const started = [];
  const failures = [];
  await followStream({
    url: () => '/events?after=' + cursor.value,
    signal: controller.signal,
    retryMs: 250,
    request: async url => {
      requests.push(url);
      started.push(Date.now());
      return eventResponse(requests.length);
    },
    onMessage: message => {
      const event = JSON.parse(message.data).event;
      cursor.value = event.event_id;
      if (cursor.value === 2) controller.abort();
    },
    onFailure: error => failures.push(error.message),
  });
  assert.deepEqual(requests, ['/events?after=0', '/events?after=1']);
  assert.ok(started[1] - started[0] >= 150, 'clean EOF uses the retry delay instead of a hot reconnect loop');
  assert.deepEqual(failures, []);
});

test('a rejected sealed-message handler stops the stream and does not poison the next board operation [H16,H3]', async () => {
  const controller = new AbortController();
  const entry = {};
  let requests = 0;
  let failure;
  let fatal = false;
  await followStream({
    url: () => '/events?after=0',
    signal: controller.signal,
    retryMs: 20,
    request: async () => { requests += 1; return eventResponse(1); },
    onMessage: message => enqueueStream(entry, async () => {
      assert.equal(JSON.parse(message.data).event.event_id, 1);
      throw new Error('sealed event could not be decrypted');
    }),
    onFailure: (error, state) => { failure = error.message; fatal = state.fatal; if (state.fatal) controller.abort(); },
  });
  assert.equal(requests, 1, 'message failures stop instead of replaying the same bad record every retry interval');
  assert.equal(failure, 'sealed event could not be decrypted');
  assert.equal(fatal, true);
  let nextOperationRan = false;
  await enqueueStream(entry, async () => { nextOperationRan = true; });
  assert.equal(nextOperationRan, true, 'the failed stream task is handled and later board work remains usable');
});

test('aborting a pending stream read prevents reconnect and closes its reader [H16,H3]', async () => {
  const controller = new AbortController();
  let requests = 0;
  let failures = 0;
  const response = new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
  const running = followStream({
    url: () => '/events?after=0',
    signal: controller.signal,
    retryMs: 20,
    request: async () => { requests += 1; return response; },
    onMessage: async () => {},
    onFailure: () => { failures += 1; },
  });
  await delay(20);
  controller.abort();
  await running;
  assert.equal(requests, 1);
  assert.equal(failures, 0, 'intentional close is not reported as a relay failure');
});
