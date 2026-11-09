/** A board's state stays materialized: reads never build, and each build extends the last one item by item [A2,C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { viewApiPorts } from '../apps/view/index.js';
import { refusalDocument } from '../apps/cli/index.js';
import { createStateSnapshots, serveApi } from '../packages/api/index.js';
import { apiBoardOpeners } from './board-fixture.js';
import { apiHttpFixture } from './api-fixture.js';
import { fileFixtureItem } from './testkit-fixture.js';
import { main } from './native-cli-fixture.js';

const STATE_PORTS = new URL('../apps/cli/src/shell/commands/serve.js', import.meta.url).href;
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

/** Serve the fixture with the state worker, and read its state over HTTP. */
async function materializedApi(t, box, builds, statePorts = STATE_PORTS) {
  const records = [];
  const waiting = new Set();
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, statePorts,
    onStateBuild: (build) => builds.push(build), projects: () => [{ root: box.root, name: 'Materializer fixture' }],
    onStateRecord: (record) => { records.push(record); for (const waiter of waiting) waiter(record); } });
  /** Resolve once a built (not restored) record at or past `sequence` has landed. */
  const landed = (sequence) => new Promise((done) => {
    const check = (record) => { if (!record.restored && record.sequence >= sequence) { waiting.delete(check); done(record); } };
    for (const record of records) check(record);
    if (!records.some((record) => !record.restored && record.sequence >= sequence)) waiting.add(check);
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
  return { api, read, landed };
}

test('[A2,C7] a state read after one appended event serves the materialized build and never builds', async (t) => {
  const { box, file, ids } = largeBoard(t);
  const builds = [];
  const { api, read, landed } = await materializedApi(t, box, builds);
  const first = await read();
  assert.equal(first.status, 200, JSON.stringify(first.document));
  const sequence = first.document.state.sequence;
  assert.deepEqual(builds.map((build) => build.full), [true], 'only the first read waits, on the one full build');
  appendLater(file, ids, 1, 70_000);
  const fullBefore = builds.filter((build) => build.full).length;
  const after = await read();
  assert.ok(after.ms < 250, `a read after an append is served in ${after.ms.toFixed(1)} ms, under 250 ms`);
  assert.equal(after.document.state.sequence, sequence, 'the read served the build it already had');
  await landed(sequence + 1);
  const caught = await read();
  assert.equal(caught.document.state.sequence, sequence + 1, 'the appended event reaches the next read');
  assert.equal(builds.filter((build) => build.full).length, fullBefore, 'catching up on the event extended the last build');
  const delta = await read(`since=${caught.document.state.sequence}`);
  assert.equal(delta.status, 200);
  assert.equal(delta.document.sequence, caught.document.state.sequence);
  assert.ok(delta.document.delta, 'a delta from a sequence the server sent is answered, not reset');
  await api.close();
  const cache = join(box.root, '.git', 'pullboard', 'state-cache');
  assert.ok(existsSync(cache) && readdirSync(cache).some((name) => name.endsWith('.result')), 'closing saves the board state to disk');

  const restarted = [];
  const again = await materializedApi(t, box, restarted);
  const resumed = await again.read();
  assert.ok(resumed.document.state.sequence >= sequence + 1, 'a restarted server serves the saved build at once');
  await again.landed(sequence + 1);
  assert.ok(restarted.every((build) => build.full === false), 'a restarted server extends the saved build instead of rebuilding every item');
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
