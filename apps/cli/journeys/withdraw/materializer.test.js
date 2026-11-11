/** A board's state stays materialized: reads never build, and each build extends the last one item by item [A2,C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { viewApiPorts } from '../../../view/index.js';
import { refusalDocument } from '../../index.js';
import {
  createStateSnapshots,
  serveApi,
} from '../../../../packages/api/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { main } from '../../tests/fixtures/native.js';

const STATE_PORTS = new URL('../../src/io/commands/serve.js', import.meta.url).href;
const BRIEF = 'Files:\n- app/large.js\nChange:\n- Keep it.\nTest:\n- It reads fast.';

/** A fixture board with `items` items filed through the CLI and `events` events in all, the rest edits spread over the items. */
function largeBoard(t, { items = 24, events = 12_000 } = {}) {
  const box = apiHttpFixture(t);
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const ids = [];
  for (let index = 0; index < items; index += 1) {
    ids.push(box.cli(box.root, 'add', 'app', `Large item ${index + 1}`, '--route', 'strong', '--criterion', `Detail ${index + 1}`, '--brief', BRIEF).item.item_id);
  }
  const db = new DatabaseSync(file);
  try { appendEdits(db, ids, events - db.prepare('SELECT COUNT(*) AS n FROM event').get().n); } finally { db.close(); }
  return { box, file, ids };
}

/** Append `count` edit events, one transaction, as agents' edits would land between reads. */
function appendEdits(db, ids, count, start = 0) {
  const insert = db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'edit', ?, '{}')");
  db.exec('BEGIN');
  for (let event = 0; event < count; event += 1) insert.run(new Date(Date.UTC(2026, 0, 1, 0, 0, start + event)).toISOString(), ids[(start + event) % ids.length]);
  db.exec('COMMIT');
}

/** Append edits on a plain connection, as another process's write lands, without the board's own open and close. */
function appendLater(file, ids, count, start) {
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout = 5000'); appendEdits(db, ids, count, start); } finally { db.close(); }
}

/** The state a build serves, as JSON would carry it. */
function plain(entry) {
  return JSON.parse(JSON.stringify(entry.state));
}

test('[A2,C7] an incremental board state equals a full rebuild over sampled event sequences', async (t) => {
  const { box, file, ids } = largeBoard(t);
  const clock = { at: Date.parse('2026-01-02T00:00:00.000Z') };
  const builds = [];
  const options = { projects: () => [{ root: box.root, name: 'Materializer fixture' }], boardOpeners: apiBoardOpeners, viewPorts: viewApiPorts, now: () => clock.at };
  const incremental = createStateSnapshots({ ...options, onStateBuild: (build) => builds.push(build) });
  const board = { id: 'materializer-fixture', root: box.root };
  incremental.withSnapshot(board, plain);
  assert.deepEqual(builds.map((build) => build.full), [true], 'the first build reads every item');
  const steps = [
    () => appendLater(file, ids, 1, 50_000),
    () => box.cli(box.root, 'shout', 'all', 'Materializer fixture: one shout between reads'),
    () => fileFixtureItem(box, box.root, { lane: 'app', title: 'Added between reads' }),
    () => box.cli(box.root, 'edit', String(ids[7]), '--criterion', 'Detail 8, edited between reads'),
    () => box.cli(box.root, 'fact', String(ids[11]), 'note', 'A fact between reads'),
    () => box.cli(box.root, 'withdraw', String(ids[3]), 'Withdrawn between reads'),
    () => appendLater(file, ids, 40, 60_000),
    () => execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'chore: move the trunk between reads'], { cwd: box.root, env: box.env }),
  ];
  for (const [index, step] of steps.entries()) {
    step();
    clock.at += 1_000;
    // A move can append a follow-up event of its own (an add's check baseline), so compare builds at one sequence.
    let extended, rebuilt;
    for (let tries = 0; tries < 200 && (!extended || extended.sequence !== rebuilt.sequence); tries += 1) {
      extended = incremental.withSnapshot(board, plain);
      rebuilt = createStateSnapshots(options).withSnapshot(board, plain);
    }
    assert.deepEqual(extended, rebuilt, `after step ${index + 1} the extended state is the full rebuild`);
    assert.equal(builds.at(-1).full, false, `step ${index + 1} extended the last build instead of rebuilding every item`);
  }
});

test('[A2,C7] a build extends the kept event history with exactly the rows appended since', (t) => {
  const { box, file, ids } = largeBoard(t, { items: 3, events: 80 });
  const clock = { at: Date.parse('2026-01-02T00:00:00.000Z') };
  const snapshots = createStateSnapshots({ projects: () => [{ root: box.root, name: 'Materializer fixture' }], boardOpeners: apiBoardOpeners, viewPorts: viewApiPorts, now: () => clock.at });
  const board = { id: 'materializer-fixture', root: box.root };
  /** The event ids a build kept, against the ids the board holds now. */
  const kept = () => snapshots.withSnapshot(board, (entry) => entry.comparisonHistory.map((event) => event.event_id));
  const stored = () => {
    const db = new DatabaseSync(file);
    try { return db.prepare('SELECT event_id FROM event ORDER BY event_id').all().map((row) => row.event_id); } finally { db.close(); }
  };
  assert.deepEqual(kept(), stored(), 'the first build reads the whole history');
  appendLater(file, ids, 5, 80_000);
  clock.at += 1_000;
  assert.deepEqual(kept(), stored(), 'a build after appended events holds the old history and the new rows, in order');
  appendLater(file, ids, 2, 90_000);
  clock.at += 1_000;
  assert.deepEqual(kept(), stored(), 'a second extension still equals the board history');
});

/** Serve the fixture with the state worker, and read its state over HTTP. */
async function materializedApi(t, box, builds, statePorts = STATE_PORTS) {
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, statePorts,
    onStateBuild: (build) => builds.push(build), projects: () => [{ root: box.root, name: 'Materializer fixture' }]
  });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const id = (await (await fetch(url.origin + '/api/v1/boards', { headers })).json()).boards[0].id;
  /** One timed state read: its document and how long it took. */
  async function read(query = 'items=compact') {
    const started = performance.now();
    const response = await fetch(`${url.origin}/api/v1/boards/${id}/state?${query}`, { headers }).catch((error) => { throw Object.assign(new Error(`state read failed: ${error.cause?.message ?? error.message}`), { cause: error }); });
    const document = await response.json();
    return { status: response.status, document, ms: performance.now() - started };
  }
  return { api, read };
}

test('[A2,C7] a read with no write starts no build, and a read after a write returns the write', async (t) => {
  const { box, file, ids } = largeBoard(t);
  const builds = [];
  const { api, read } = await materializedApi(t, box, builds);
  const first = await read();
  assert.equal(first.status, 200, JSON.stringify(first.document));
  const sequence = first.document.state.sequence;
  assert.deepEqual(builds.map((build) => build.full), [true], 'only the first read waits, on the one full build');
  for (let index = 0; index < 5; index += 1) {
    const unchanged = await read();
    assert.ok(unchanged.ms < 250, `a read of an unchanged board is served in ${unchanged.ms.toFixed(1)} ms, under 250 ms`);
    assert.equal(unchanged.document.state.sequence, sequence);
  }
  assert.equal(builds.length, 1, 'reads of an unchanged board start no build');
  appendLater(file, ids, 1, 70_000);
  const fullBefore = builds.filter((build) => build.full).length;
  const after = await read();
  assert.equal(after.document.state.sequence, sequence + 1, 'the read right after a write returns the written event');
  assert.equal(builds.filter((build) => build.full).length, fullBefore, 'catching up on the event extended the last build');
  const delta = await read(`since=${after.document.state.sequence}`);
  assert.equal(delta.status, 200);
  assert.equal(delta.document.sequence, after.document.state.sequence);
  assert.ok(delta.document.delta, 'a delta from a sequence the server sent is answered, not reset');
  await api.close();
  const cache = join(box.root, '.git', 'pullboard', 'state-cache');
  assert.ok(existsSync(cache) && readdirSync(cache).some((name) => name.endsWith('.result')), 'closing saves the board state to disk');

  const restarted = [];
  const again = await materializedApi(t, box, restarted);
  const resumed = await again.read();
  assert.equal(resumed.document.state.sequence, sequence + 1, 'a restarted server serves the saved build at once');
  assert.ok(restarted.every((build) => build.full === false), 'a restarted server extends the saved build instead of rebuilding every item');
});

test('[A2,C7] an open page hears one change notice per write, and none from its own reads', async (t) => {
  const box = apiHttpFixture(t);
  const ids = [1, 2].map((index) => box.cli(box.root, 'add', 'app', `Notice item ${index}`, '--route', 'strong', '--criterion', `Detail ${index}`, '--brief', BRIEF).item.item_id);
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const builds = [];
  const { api, read } = await materializedApi(t, box, builds);
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const id = (await (await fetch(url.origin + '/api/v1/boards', { headers })).json()).boards[0].id;
  await read();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${url.origin}/api/v1/boards/${id}/events`, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal });
  const decoder = new TextDecoder();
  let text = '';
  const waiters = new Set();
  /** Resolve once the stream text satisfies `ready`; the stream's own frames drive it, never a timer. */
  const until = (ready) => new Promise((done) => { const check = () => { if (ready()) { waiters.delete(check); done(); } }; waiters.add(check); check(); });
  const pump = (async () => {
    try { for await (const chunk of response.body) { text += decoder.decode(chunk, { stream: true }); for (const check of [...waiters]) check(); } }
    catch { /* The test aborts the stream. */ }
  })();
  const changes = () => text.split('event: changed').length - 1;
  await until(() => text.includes(': API v1'));
  const built = builds.length;
  for (let index = 0; index < 20; index += 1) await read();
  assert.equal(builds.length, built, 'twenty reads of an unchanged board start no build');
  appendLater(file, ids, 1, 80_000);
  await until(() => changes() >= 1);
  for (let index = 0; index < 5; index += 1) await read();
  appendLater(file, ids, 1, 80_001);
  await until(() => changes() >= 2);
  const second = await read();
  assert.equal(changes(), 2, 'each write sends one change notice, and the page reads between them send none');
  assert.equal(second.document.state.sequence, (await read()).document.state.sequence, 'the page read after the second write is current');
  controller.abort();
  await pump;
});

test('[A2,C7] a state worker that cannot start never fails a read: the server builds on the request thread', async (t) => {
  const box = apiHttpFixture(t);
  const { read } = await materializedApi(t, box, [], 'data:text/javascript,throw new Error("no state ports here")');
  const first = await read();
  assert.equal(first.status, 200, JSON.stringify(first.document));
  assert.ok(Number.isSafeInteger(first.document.state.sequence));
  const second = await read();
  assert.equal(second.status, 200, JSON.stringify(second.document));
});
