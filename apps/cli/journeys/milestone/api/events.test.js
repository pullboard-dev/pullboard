import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { EVENT_LOG_VERSION } from '../../../../../packages/store/index.js';
import { SIGNED_EVENT_LOG_VERSION } from '../../../../../packages/store/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { apiError } from '../../../tests/fixtures/api.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../../tests/fixtures/api.js';
import { nextSseEvent } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { readEventLogVersion } from '../../../tests/fixtures/api/project.js';
import { setEventLogVersion } from '../../../tests/fixtures/api/project.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';

// The newest event-log format this Pullboard reads: a board with signed person moves is format 2 [E22].
const READABLE_EVENT_LOG = Math.max(EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION);
test('cli.journeys-milestone-api-events.http-decisions-preserve-routing-passing-and: [A2,B25,B26,B27] HTTP decisions preserve routing, passing and explicit person answers', async (t) => {
  const box = project();
  const app = join(box.dir, 'app-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
  assert.equal((await fixtureJoin((...a) => runLocal(box, ...a), app, 'app')).status, 0);
  // The standalone API serves the 'api' person channel; the handler's default is the view's [P6].
  const api = await startLocalHandler(t, box, { personChannel: 'api' });
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  /** Send a real HTTP move while retaining the caller and CLI argument boundaries. */
  const move = (verb, args, item, agent = 'coordinator') => apiFetch(api, `${path}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb, args, ...(item === undefined ? {} : { item }), agent }),
  });

  const askResponse = await move('shout', { text: 'May this ship?', kind: 'question', decision: true }, undefined, 'app-1');
  assert.equal(askResponse.status, 200);
  const ask = await askResponse.json();
  assert.equal(ask.version, 1);
  assert.equal(ask.event.event_kind, 'shout');
  assert.equal(ask.event.event_by, 'app-1');
  assert.equal(JSON.parse(ask.event.event_detail).to, 'coordinator');

  const notCoordinator = JSON.parse((await runLocal(box, app, 'pass', String(ask.result.id), 'Needs the person', '--json')).stdout).error;
  assert.deepEqual(await apiError(await move('pass', { note: 'Needs the person' }, ask.result.id, 'app-1'), 409), notCoordinator);

  const passResponse = await move('pass', { note: 'Needs the person' }, ask.result.id);
  assert.equal(passResponse.status, 200);
  const passed = await passResponse.json();
  assert.equal(passed.version, 1);
  assert.equal(passed.event.event_kind, 'pass');
  assert.equal(JSON.parse(passed.event.event_detail).to, 'person');

  const personRequired = JSON.parse((await runLocal(box, box.repo, 'answer', String(passed.result.id), 'Approved', '--json')).stdout).error;
  assert.equal(personRequired.code, 'B26_PERSON_ANSWER');
  assert.deepEqual(await apiError(await move('answer', { text: 'Approved' }, passed.result.id), 409), personRequired);
  // A serve key is not the person: an explicit person answer through the standalone API records nothing [P6].
  const eventsBefore = json(box, box.repo, 'log').events.length;
  assert.equal((await apiError(await move('answer', { text: 'Approved', as: 'person' }, passed.result.id), 409)).code, 'B26_PERSON_CHANNEL');
  assert.equal(json(box, box.repo, 'log').events.length, eventsBefore, 'a refused API person answer records no event');
  assert.ok((await (await apiFetch(api, `${path}/state`)).json()).state.decisions.some((entry) => entry.shout_id === passed.result.id),
    'the passed decision still waits for the person');
  // The view's own adapter keeps the person channel, so the person's explicit answer still routes back to the asker.
  const view = await startLocalHandler(t, box);
  const answerResponse = await apiFetch(view, `${path}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'answer', item: passed.result.id, args: { text: 'Approved', as: 'person' }, agent: 'coordinator' }),
  });
  assert.equal(answerResponse.status, 200);
  const answered = await answerResponse.json();
  assert.equal(answered.version, 1);
  assert.equal(answered.event.event_by, 'person');
  assert.equal(answered.event.event_kind, 'answer');
  const replies = json(box, app, 'inbox').shouts;
  assert.ok(replies.some((entry) => entry.shout_answers === ask.result.id && entry.shout_from === 'person' && entry.shout_text.includes('Approved')));
  assert.deepEqual((await (await apiFetch(api, `${path}/state`)).json()).state.decisions, []);
});

test('cli.journeys-milestone-api-events.sse-delivers-a-live-move-and: [A2] SSE delivers a live move and resumes after Last-Event-ID without replay', async (t) => {
  const box = project();
  // The two near-identical item titles are fixture data, not a duplicate filing the board should refuse.
  box.env.PULLBOARD_FIXTURE_ADD_DISTINCT = '1';
  const api = await startLocalHandler(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  const backlog = await (await apiFetch(api, `${path}/events?after=0`)).json();
  const cursor = backlog.events.at(-1)?.event_id ?? 0;
  const eventUrl = `${path}/events?after=${cursor}`;

  const firstResponse = await apiFetch(api, eventUrl, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(10_000) });
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get('content-type'), /text\/event-stream/);
  const firstReader = firstResponse.body.getReader();
  const firstPending = { text: '' };
  let firstEvent;
  try {
    const firstMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live one' } }) });
    assert.equal(firstMove.status, 200);
    const expectedFirst = await firstMove.json();
    firstEvent = await nextSseEvent(firstReader, firstPending);
    assertRequiredShape(firstEvent.document, JSON_SHAPES.http.stream.required, 'SSE event');
    assert.equal(firstEvent.document.version, 1);
    assert.equal(firstEvent.id, String(expectedFirst.event.event_id));
    assert.deepEqual(firstEvent.document.event, expectedFirst.event);
  } finally {
    await firstReader.cancel();
  }

  const reconnect = await apiFetch(api, `${path}/events`, {
    headers: { accept: 'text/event-stream', 'last-event-id': firstEvent.id },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(reconnect.status, 200);
  const reader = reconnect.body.getReader();
  try {
    const pending = { text: '' };
    const placement = await nextSseEvent(reader, pending);
    assert.equal(placement.document.event.event_kind, 'milestone_placed');
    assert.equal(placement.document.event.item_id, firstEvent.document.event.item_id);
    const secondMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live two' } }) });
    assert.equal(secondMove.status, 200);
    const expectedSecond = await secondMove.json();
    const second = await nextSseEvent(reader, pending);
    assert.equal(second.id, String(expectedSecond.event.event_id));
    assert.ok(Number(second.id) > Number(firstEvent.id), 'the reconnect resumed after the delivered event without replay');
    assert.equal(second.document.event.event_kind, 'add');
    assert.notEqual(second.id, firstEvent.id);
  } finally {
    await reader.cancel();
  }
});

test('cli.journeys-milestone-api-events.doctor-diagnoses-future-event-logs-read: [A5,A6] doctor diagnoses future event logs read-only and accepts the current marker', async () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION));
  const beforeCurrent = readFileSync(file);
  const current = await runLocal(box, box.repo, 'doctor', '--json');
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.equal(current.stderr, '');
  assert.deepEqual(JSON.parse(current.stdout).problems, [], 'the current event-log version is healthy');
  assert.deepEqual(readFileSync(file), beforeCurrent, 'doctor leaves a current board byte-for-byte unchanged');

  setEventLogVersion(file, READABLE_EVENT_LOG + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before modeling the future version');
  const futureBytes = readFileSync(file);
  const refused = await runLocal(box, box.repo, 'doctor', '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'doctor returns a JSON finding');
  const problems = JSON.parse(refused.stdout).problems;
  const problem = problems.find((entry) => entry.code === 'EVENT_LOG_VERSION');
  assert.ok(problem, refused.stdout);
  assert.match(problem.message, new RegExp(`event log version ${READABLE_EVENT_LOG + 1}.*version ${READABLE_EVENT_LOG}`));
  assert.match(problem.next, /upgrade pullboard/i);
  assert.deepEqual(readFileSync(file), futureBytes, 'the read-only diagnosis preserves the complete board file');
  assert.equal(readEventLogVersion(file), String(READABLE_EVENT_LOG + 1), 'doctor does not silently upgrade the marker');
});

test('cli.journeys-milestone-api-events.view-export-preserves-the-typed-future: [A5] view export preserves the typed future-version refusal without creating output', async () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Export version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  setEventLogVersion(file, READABLE_EVENT_LOG + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before export refuses');
  const before = readFileSync(file);
  const output = join(box.dir, 'future-version-export');
  assert.equal(existsSync(output), false);

  const refused = await runLocal(box, box.repo, 'view', '--export', output, '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'view export returns a JSON refusal');
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'EVENT_LOG_VERSION', refused.stdout);
  assert.match(error.message, new RegExp(`event log version ${READABLE_EVENT_LOG + 1}.*version ${READABLE_EVENT_LOG}`));
  assert.match(error.next, /upgrade pullboard/i);
  assert.equal(existsSync(output), false, 'refused export creates no output directory or files');
  assert.deepEqual(readFileSync(file), before, 'refused export preserves every board byte');
  assert.equal(readEventLogVersion(file), String(READABLE_EVENT_LOG + 1));
});

