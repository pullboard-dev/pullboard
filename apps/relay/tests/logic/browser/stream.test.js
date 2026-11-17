/** Exercise the relay browser's SSE retry and queue lifecycle without launching Chrome [H16,H3,H5,H15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueStream } from '../../../index.js';
import { followStream } from '../../../index.js';
import { recordBrowserReadFailure } from '../../../index.js';
import { clearBrowserReadFailure } from '../../../index.js';
import { noticeLines } from '../../../index.js';
import { reconcileOwnedRequests } from '../../../index.js';
import { rememberOwnedRequestId } from '../../../index.js';
import { RELAY_FAULT_WORDS } from '../../../index.js';
import { relayFailureText } from '../../../index.js';
import { relayFault } from '../../../index.js';
import { storedOwnedRequestState } from '../../../index.js';

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

test('relay.logic-browser-stream.notice-says-only-what-is-true: notice says only what is true now [H17,H5]', () => {
  const pairedId = '12345678' + 'a'.repeat(24);
  const orphanId = '87654321' + 'b'.repeat(24);
  const paired = new Map([[pairedId, { state: { personRequests: [
    { id: 'this-device', status: 'waiting' }, { id: 'other-device', status: 'waiting' }, { id: 'finished', status: 'refused' },
  ] } }]]);
  const available = [
    { id: pairedId, repository: 'pullboard/board', linkedAt: 1767312000000 },
    { id: orphanId, repository: 'pullboard/board', linkedAt: 1767398400000 },
  ];
  const warning = { board: orphanId, code: 'BOARD_INACTIVE', daysLeft: 12 };
  const ownedRequestIds = new Map([[pairedId, new Set(['this-device', 'finished'])]]);
  const lines = noticeLines({ available, paired, ownedRequestIds, warnings: [warning] });
  assert.match(lines[0], /^1 request from this device is waiting/u, 'only waiting requests appear and the count is visible');
  assert.match(lines[1], /pullboard\/board · linked 2026-01-03 · board 87654321/u, 'a same-repository orphan is distinguished by link date and short id');
  assert.match(lines[1], /pullboard relay off.*12 days for automatic removal/u, 'the orphan notice gives both removal paths and its remaining idle time');
  assert.match(lines[2], /BOARD_INACTIVE: 12 days left/u, 'the existing retention warning remains visible');
  const noRequests = new Map([[pairedId, { state: { personRequests: [] } }]]);
  assert.deepEqual(noticeLines({ available: [available[0]], paired: noRequests, ownedRequestIds, warnings: [] }), [], 'all paired boards and no waiting requests produce an empty notice');
});

test('relay.logic-browser-stream.device-request-notices-track-only-owned: device request notices track only owned ids until their final status [H17,H5]', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  rememberOwnedRequestId(storage, 'owned', 'sent-here');
  assert.equal(values.get('owned'), '["sent-here"]', 'local ownership stores the stable id alone, not request text or ciphertext');
  const incomplete = storedOwnedRequestState(storage, 'owned', []);
  assert.deepEqual([...incomplete.owned], ['sent-here'], 'the device keeps its id while replay has not shown a receipt');

  const owned = new Set(['sent-here', 'not-yet-replayed', 'already-finished']);
  const waiting = reconcileOwnedRequests([
    { id: 'sent-here', status: 'waiting' }, { id: 'sent-elsewhere', status: 'waiting' },
    { id: 'already-finished', status: 'done' },
  ], owned);
  assert.deepEqual(waiting, { waiting: ['sent-here'], finished: ['already-finished'] },
    'another device’s waiting request is excluded while an acknowledged local id remains attributable');
  for (const id of waiting.finished) owned.delete(id);
  assert.deepEqual([...owned], ['sent-here', 'not-yet-replayed'], 'an unobserved local id survives an incomplete replay');
  const final = reconcileOwnedRequests([
    { id: 'sent-here', status: 'refused' }, { id: 'sent-elsewhere', status: 'waiting' },
  ], owned);
  assert.deepEqual(final, { waiting: [], finished: ['sent-here'] }, 'a local refusal clears its waiting notice without attributing the other device');
  const completed = storedOwnedRequestState(storage, 'owned', [{ id: 'sent-here', status: 'refused' }]);
  assert.deepEqual(completed.finished, ['sent-here']);
  assert.equal(values.get('owned'), '[]', 'the local id is removed once its final refusal is visible');
});

test('relay.logic-browser-stream.clean-sse-eof-reconnects-after-a: clean SSE EOF reconnects after a bounded delay and resumes from the delivered cursor [H16,H3]', async () => {
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

test('relay.logic-browser-stream.an-unterminated-sse-event-is-discarded: an unterminated SSE event is discarded at EOF and replayed from the unchanged cursor [H16,H3]', async () => {
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

test('relay.logic-browser-stream.a-rejected-sealed-message-handler-stops: a rejected sealed-message handler stops the stream and does not poison the next board operation [H16,H3]', async () => {
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

test('relay.logic-browser-stream.an-http-engine-version-refusal-is: an HTTP engine-version refusal is shown once and stops reconnect attempts [H16,H3]', async () => {
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

test('relay.logic-browser-stream.aborting-a-pending-stream-read-prevents: aborting a pending stream read prevents reconnect and closes its reader [H16,H3]', async () => {
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


test('relay.logic-browser-stream.checkpoint-timeout-notices-survive-activity-and: checkpoint timeout notices survive activity and recovery on another paired board [H5,H16]', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const available = [{ id: a, repository: 'fixture/one' }, { id: b, repository: 'fixture/two' }];
  const paired = new Map([[a, { repository: 'fixture/one', checkpointTimedOut: true }],
    [b, { repository: 'fixture/two', checkpointTimedOut: false }]]);
  const text = 'The relay snapshot has not caught up to this move. Retry this board.';
  const lines = () => noticeLines({ available, paired, failure: '' }).filter(line => line.includes(text));
  assert.deepEqual(lines(), ['fixture/one: ' + text], 'an unrelated successful event cannot hide this board timeout');
  paired.get(b).checkpointTimedOut = true;
  assert.deepEqual(lines(), ['fixture/one: ' + text, 'fixture/two: ' + text]);
  paired.get(b).checkpointTimedOut = false;
  assert.deepEqual(lines(), ['fixture/one: ' + text], 'covering board two cannot clear board one');
  paired.get(a).checkpointTimedOut = false;
  assert.deepEqual(lines(), [], 'every covering checkpoint clears only its own timeout');
});


test('relay.logic-browser-stream.phone-degradation-and-durable-queued-notices: phone degradation and durable queued notices remain local to each board [H5,H17]', () => {
  const degradedBoards = new Map();
  recordBrowserReadFailure(degradedBoards, 'a', Date.parse('2026-01-01T10:00:00Z'));
  recordBrowserReadFailure(degradedBoards, 'a', Date.parse('2026-01-01T10:01:00Z'));
  recordBrowserReadFailure(degradedBoards, 'b', Date.parse('2026-01-01T10:02:00Z'));
  clearBrowserReadFailure(degradedBoards, 'b');
  assert.equal(degradedBoards.get('a'), '2026-01-01T10:00:00.000Z', 'repeated failure keeps the first timestamp and other-board recovery does not clear it');
  const paired = new Map([['a', { repository: 'repo/a', state: { personRequests: [] } }], ['b', { repository: 'repo/b' }]]);
  const queuedRequests = new Map([['a', 2], ['b', 0]]);
  const lines = noticeLines({ available: [{ id: 'a', repository: 'repo/a' }, { id: 'b', repository: 'repo/b' }], paired, degradedBoards, queuedRequests });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /repo\/a: relay degraded since 10:00; 2 sealed requests queued locally/u);
  assert.match(lines[0], /has not received an acknowledgement/u, 'queued ciphertext is not an acknowledged waiting request');
  clearBrowserReadFailure(degradedBoards, 'a');
  assert.match(noticeLines({ available: [{ id: 'a' }], paired: new Map([['a', paired.get('a')]]), degradedBoards, queuedRequests })[0], /2 sealed requests queued locally/u, 'a successful read does not discard unsent ciphertext');
  queuedRequests.set('a', 0);
  assert.deepEqual(noticeLines({ available: [{ id: 'a' }], paired: new Map([['a', paired.get('a')]]), degradedBoards, queuedRequests }), []);
  queuedRequests.set('a', null);
  assert.match(noticeLines({ available: [{ id: 'a' }], paired: new Map([['a', paired.get('a')]]), degradedBoards, queuedRequests })[0], /count unavailable/u, 'unreadable device storage cannot claim zero pending requests');
});

test('relay.logic-browser-stream.each-of-the-four-relay-faults: each of the four relay faults reads as one plain next step and never as a raw code [H5,H17]', () => {
  const faults = [
    ['relay down', new TypeError('Failed to fetch'), 'down', /wait/iu],
    ['relay down, older browser', new Error('network error'), 'down', /wait/iu],
    ['slow relay that then asks for a newer snapshot', { code: 'SNAPSHOT_REQUIRED', message: 'fetch the latest sealed state, then resume.' }, 'behind', /wait/iu],
    ['503', Object.assign(new Error('The relay did not answer. Sign in again or retry.'), { code: 'RELAY_UNAVAILABLE' }), 'trouble', /wait/iu],
    ['stale engine', Object.assign(new Error('This browser reads engine 3. Upgrade this browser client.'), { code: 'ENGINE_VERSION' }), 'version', /reload this page/iu],
    ['stale engine in a bracketed message', new Error('[ENGINE_VERSION] upgrade the browser client'), 'version', /reload this page/iu],
  ];
  for (const [name, error, fault, step] of faults) {
    assert.equal(relayFault(error), fault, name);
    const words = relayFailureText(error);
    assert.equal(words, RELAY_FAULT_WORDS[fault], name);
    assert.match(words, step, name + ' names its next step');
    assert.match(words, /relay|page/iu, name + ' names the relay, not pullboard view');
    assert.doesNotMatch(words, /\[[A-Z_]+\]|Failed to fetch|network error|pullboard view/u, name + ' keeps raw words out');
  }
  assert.doesNotMatch(RELAY_FAULT_WORDS.down + RELAY_FAULT_WORDS.trouble + RELAY_FAULT_WORDS.behind, /reload/iu, 'only a new version asks for a reload');
  assert.equal(relayFault(new Error('Sign in again to read this board.')), null, 'a refusal that is no fault keeps its own sentence');
  assert.equal(relayFailureText(new Error('[AUTH_REQUIRED] Sign in again to read this board.')), 'Sign in again to read this board.', 'a leading code is dropped');
});
