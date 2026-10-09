/** Exercise the relay browser's SSE retry and queue lifecycle without launching Chrome [H16,H3,H5,H15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueStream, followStream } from '../relay/browser-stream.js';
import { noticeLines } from '../relay/browser-notice.js';

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

test('notice says only what is true now [H17,H5]', () => {
  const pairedId = '12345678' + 'a'.repeat(24);
  const orphanId = '87654321' + 'b'.repeat(24);
  const paired = new Map([[pairedId, { state: { personRequests: [{ status: 'waiting' }, { status: 'refused' }] } }]]);
  const available = [
    { id: pairedId, repository: 'pullboard/board', linkedAt: 1767312000000 },
    { id: orphanId, repository: 'pullboard/board', linkedAt: 1767398400000 },
  ];
  const warning = { board: orphanId, code: 'BOARD_INACTIVE', daysLeft: 12 };
  const lines = noticeLines({ available, paired, warnings: [warning] });
  assert.match(lines[0], /^1 request from this device is waiting/u, 'only waiting requests appear and the count is visible');
  assert.match(lines[1], /pullboard\/board · linked 2026-01-03 · board 87654321/u, 'a same-repository orphan is distinguished by link date and short id');
  assert.match(lines[1], /pullboard relay off.*12 days for automatic removal/u, 'the orphan notice gives both removal paths and its remaining idle time');
  assert.match(lines[2], /BOARD_INACTIVE: 12 days left/u, 'the existing retention warning remains visible');
  const noRequests = new Map([[pairedId, { state: { personRequests: [] } }]]);
  assert.deepEqual(noticeLines({ available: [available[0]], paired: noRequests, warnings: [] }), [], 'all paired boards and no waiting requests produce an empty notice');
});

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

test('an unterminated SSE event is discarded at EOF and replayed from the unchanged cursor [H16,H3]', async () => {
  const controller = new AbortController();
  const requests = [];
  const cursor = { value: 0 };
  const received = [];
  const failures = [];
  const partial = new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('id: 1\ndata: {"version":1,"event":'));
      stream.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  await followStream({
    url: () => '/events?after=' + cursor.value,
    signal: controller.signal,
    retryMs: 5,
    request: async url => {
      requests.push(url);
      return requests.length === 1 ? partial : eventResponse(1);
    },
    onMessage: message => {
      received.push(message);
      cursor.value = JSON.parse(message.data).event.event_id;
      controller.abort();
    },
    onFailure: error => failures.push(error.message),
  });
  assert.deepEqual(requests, ['/events?after=0', '/events?after=0'], 'partial bytes never advance the replay cursor');
  assert.equal(received.length, 1, 'only the complete replayed event is delivered');
  assert.equal(JSON.parse(received[0].data).event.event_id, 1);
  assert.deepEqual(failures, [], 'an incomplete tail is ordinary EOF, not a fatal malformed message');
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

test('an HTTP engine-version refusal is shown once and stops reconnect attempts [H16,H3]', async () => {
  const controller = new AbortController();
  let requests = 0;
  let notice = '';
  let fatal = false;
  await followStream({
    url: () => '/events?after=0',
    signal: controller.signal,
    retryMs: 10,
    request: async () => {
      requests += 1;
      const response = new Response(JSON.stringify({ error: { code: 'ENGINE_VERSION', message: 'Upgrade pullboard before reading relay records.' } }), { status: 400 });
      const body = await response.json();
      const error = Object.assign(new Error('[' + body.error.code + '] ' + body.error.message), { code: body.error.code, fatal: body.error.code === 'ENGINE_VERSION' });
      throw error;
    },
    onMessage: async () => {},
    onFailure: (error, state) => { notice = error.message; fatal = state.fatal; },
  });
  assert.equal(requests, 1, 'old-engine refusal is not retried as a transient network failure');
  assert.equal(fatal, true);
  assert.match(notice, /\[ENGINE_VERSION\].*Upgrade pullboard/u, 'upgrade guidance remains visible');
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
