/** HTTP event stream fixtures cover state changes, lease expiry and multiple-board cursors [A2,N26]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { board as store } from '../../../lib/index.js';
import { registerProject } from '../../../../packages/seats/index.js';
import { serveView } from '../../src/io/commands/view.js';
import { main as nativeTestMain } from '../../tests/fixtures/native.js';
import {
  apiHttpFixture as fixture,
  apiHttpBox as httpBox,
  registerFixtureRunner,
  shellWord,
  FIXTURE_BRIEF,
} from '../../tests/fixtures/api.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { liveFrames } from '../../tests/fixtures/http/stream.js';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import { PULLBOARD_ENTRY } from '../../src/io/resident/client.js';
import { residentPoolSize } from '../../src/io/resident/client.js';
import { residentSocket } from '../../src/io/resident/client.js';
import { performance } from 'node:perf_hooks';

/** Commit a fixture-owned app change so the native submit move has a real head to capture. */
function commitAppChange(worktree, filename, env) {
  mkdirSync(join(worktree.path, 'app'), { recursive: true });
  writeFileSync(join(worktree.path, 'app', filename), 'export const fixture = true;\n');
  runFixtureGit(['add', '--', `app/${filename}`], { cwd: worktree.path, env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', `feat(test): add ${filename} [G1]`], { cwd: worktree.path, env, stdio: 'pipe' });
}

/** Serve a registered private fixture through the actual person's view adapter. */
async function viewHttpBox(t, existing = null) {
  const box = existing ?? fixture(t);
  const previousHome = process.env.PULLBOARD_HOME;
  let view;
  t.after(async () => {
    try { await view?.close(); }
    finally {
      if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
      else process.env.PULLBOARD_HOME = previousHome;
    }
  });
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  registerProject(box.root);
  view = await serveView({ port: 0, runCommand: nativeTestMain });
  const url = new URL(view.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call to this fixture's view and decode its versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1);
  const id = listed.document.boards[0].id;
  return { ...box, api: view, origin, key, id, call, path: '/api/v1/boards/' + id };
}

test('[A2] real HTTP state, moves and refusals use the CLI and exact committed events', async (t) => {
  const box = await httpBox(t);
  // This test never registers a runner, so its submit and next --verify must settle in the command: pin controller dispatch [P7].
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  const one = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-one');
  const two = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-two');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'HTTP item', criterion: 'complete', specs: 'G1', brief: FIXTURE_BRIEF } });
  assert.equal(added.status, 200);
  assert.equal(added.document.event.event_kind, 'add');
  const id = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: one.agent });
  assert.equal(claimed.status, 200);
  commitAppChange(one, `http-${id}.js`, box.env);
  assert.equal(claimed.document.event.event_by, one.agent);
  assert.equal(claimed.document.event.event_kind, 'claim');
  const refused = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: two.agent });
  const terminal = await runCliInProcess(['claim', String(id), '--json'], { cwd: two.path, env: box.env });
  assert.equal(refused.status, 409);
  assert.equal(terminal.status, 1);
  assert.equal(refused.document.error.code, JSON.parse(terminal.stdout).error.code);
  assert.deepEqual(refused.document.error, JSON.parse(terminal.stdout).error, 'the original CLI refusal keeps its message and next step');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.board, box.id);
  assert.equal(state.document.state.items.find((item) => item.id === id).claim.by, one.agent);
  assert.equal((await box.call(box.path + '/items/' + id)).document.item.owner, one.agent);
  const events = await box.call(box.path + '/events?after=' + added.document.event.event_id);
  assert.deepEqual(events.document.events.map((event) => event.event_kind), ['milestone_placed', 'claim']);
  assert.equal(events.document.events[0].item_id, id);
  assert.deepEqual(events.document.events[1], claimed.document.event);
  const badAgent = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: 'absent-agent' });
  assert.equal(badAgent.status, 409);
  assert.equal(badAgent.document.error.code, 'NO_AGENT');
  const submitted = await box.call(box.path + '/moves', { verb: 'submit', item: id, agent: one.agent });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.document));
  const review = await box.call(box.path + '/moves', { verb: 'next', agent: two.agent, args: { verify: true } });
  assert.equal(review.status, 200, JSON.stringify(review.document));
  assert.equal(review.document.result.item.item_id, id);
  const missingNote = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { reason: 'BLOCKED' } });
  assert.equal(missingNote.status, 409);
  assert.equal(missingNote.document.error.code, 'NOTE_REQUIRED');
  const release = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { note: 'reviewed the wrong tree', reason: 'OTHER' } });
  assert.equal(release.status, 200, JSON.stringify(release.document));
  assert.deepEqual(JSON.parse(release.document.event.event_detail), { review: true, reason: 'reviewed the wrong tree', reasonCode: 'OTHER', model: 'fixture-two' });
});

test('[A2,V2,H16] board-state JSON retains pending and red baselines and removes cleared observations', async (t) => {
  const box = await httpBox(t);
  const pending = { command: 'true', main: box.commit, result: 'pending', request: randomUUID() };
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let id;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Captured API observation',
      check: pending.command, checkBaseline: pending });
  } finally { store.closeBoard(board); }
  const initial = await box.call(box.path + '/items/' + id);
  assert.deepEqual(initial.document.item.checkBaseline, pending,
    'a pending captured request reaches the public state endpoint before completion');
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const completed = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.completeCheckBaseline(completed, id, { agentId: 'coordinator', expected: pending,
      baseline: { command: pending.command, main: pending.main, result: 'red', seconds: 1 } });
  } finally { store.closeBoard(completed); }
  const redState = await box.call(box.path + '/items/' + id);
  const red = redState.document.item.checkBaseline;
  assert.deepEqual(red, { command: pending.command, main: pending.main, result: 'red', seconds: 1, request: pending.request });
  assert.equal(Object.hasOwn(red, 'warning'), false, 'a failing baseline has no proves-nothing warning');
  const cleared = await box.call(box.path + '/moves', { verb: 'edit', item: id, args: { check: '' } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.document));
  const clearedState = await box.call(box.path + '/items/' + id);
  const clearedItem = clearedState.document.item;
  assert.equal(clearedItem.check, '');
  assert.equal(Object.hasOwn(clearedItem, 'checkBaseline'), false, 'clearing the check removes its old observation from API state');
});

test('[A2,V2] HTTP add and edit preserve explicit blocking baseline requests', async (t) => {
  const box = await httpBox(t);
  registerFixtureRunner(t, box);
  /** Build a finite check whose completion can be observed independently of the HTTP response. */
  function completedCheck(marker) {
    const script = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished')`;
    return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
  }
  const firstMarker = join(box.dir, 'add-finished');
  const check = completedCheck(firstMarker);
  const added = await box.call(box.path + '/moves', { verb: 'add', args: {
    lane: 'app', title: 'Blocking API check', check, wait: true,
  } });
  assert.equal(added.status, 200, JSON.stringify(added.document));
  const item = added.document.result.item;
  assert.equal(item.item_check_baseline.result, 'green', '--wait returns a terminal observation in the add response');
  assert.equal(item.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(firstMarker, 'utf8'), 'finished');
  const addedState = await box.call(box.path + '/items/' + item.item_id);
  const projected = addedState.document.item;
  assert.equal(projected.check, check);
  assert.deepEqual(projected.checkBaseline, item.item_check_baseline, 'board-state item JSON carries the same complete observation and warning');
  const secondMarker = join(box.dir, 'edit-finished');
  const editedCheck = completedCheck(secondMarker);
  const edited = await box.call(box.path + '/moves', { verb: 'edit', item: item.item_id, args: {
    check: editedCheck, wait: true,
  } });
  assert.equal(edited.status, 200, JSON.stringify(edited.document));
  assert.equal(edited.document.result.item.item_check_baseline.command, editedCheck);
  assert.equal(edited.document.result.item.item_check_baseline.result, 'green', '--wait also blocks edit until its new check finishes');
  assert.equal(readFileSync(secondMarker, 'utf8'), 'finished');
  const editedState = await box.call(box.path + '/items/' + item.item_id);
  const editedItem = edited.document.result.item;
  assert.deepEqual(editedState.document.item.checkBaseline,
    editedItem.item_check_baseline, 'board-state JSON replaces the observation when the check changes');
});

test('[A2, H12, R2] requests and shouts append events and requests stay outside decisions', async (t) => {
  const box = await viewHttpBox(t);
  const requested = await box.call(box.path + '/requests', { text: 'Please approve the fixture row.' });
  assert.equal(requested.status, 200);
  assert.equal(requested.document.result.request, true);


  assert.equal(requested.document.event.event_kind, 'shout');
  const shout = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: 'new work' } });
  assert.equal(shout.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.requests.length, 1);
  assert.equal(state.document.state.decisions.length, 0);
  const premature = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'I am working on it' } });
  assert.equal(premature.status, 409);
  assert.equal(premature.document.error.code, 'REQUEST_OUTCOME');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 1);
  const answer = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'done checked and recorded' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.document.event.event_kind, 'answer');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 0);
});

test('[A2] a live HTTP stream follows CLI writes and reconnects after Last-Event-ID', async (t) => {
  const box = await httpBox(t);
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, { headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffered = '';
  /** Read a complete live event with a bounded timeout. */
  async function frame() {
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      while (!/\ndata: .+\n\n/.test(buffered)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream stays open until its event arrives');
        buffered += new TextDecoder().decode(value);
      }
      const match = /id: (\d+)\ndata: (.+)\n\n/.exec(buffered);
      assert.ok(match);
      buffered = buffered.slice(match.index + match[0].length);
      return { id: Number(match[1]), document: JSON.parse(match[2]) };
    } finally { clearTimeout(timeout); }
  }
  const added = await box.cliLocal(box.root, 'add', 'app', 'Terminal event', '--criterion', 'done', '--specs', 'G1');
  const live = await frame();
  assert.equal(live.document.version, 1);
  assert.equal(live.document.event.event_kind, 'add');
  assert.equal(live.document.event.item_id, added.item.item_id);
  assert.equal(live.id, live.document.event.event_id);
  await reader.cancel();
  controller.abort();
  const replay = await fetchFresh(box.origin + box.path + '/events?after=0', { headers: { 'x-pullboard-key': box.key, 'last-event-id': String(live.id) } });
  const replayed = (await replay.json()).events;
  assert.deepEqual(replayed.map(event => [event.event_kind, event.item_id]), [['milestone_placed', added.item.item_id]], 'the later placement event replays after the add cursor');
  const invalid = await box.call(box.path + '/events?after=1.5');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.document.error.code, 'BAD_CURSOR');
});

test('[A2, N26] the event stream says when the board changes without a move', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const external = fixture(t);
  const externalConfigPath = join(external.root, 'pullboard.json');
  writeFileSync(externalConfigPath, JSON.stringify({ ...JSON.parse(readFileSync(externalConfigPath, 'utf8')), name: 'Roadmap fixture' }));
  runFixtureGit(['commit', '-q', '-m', 'chore: name the roadmap fixture', '--', 'pullboard.json'], { cwd: external.root, env: external.env, stdio: 'pipe' });
  const externalAdded = await external.cliLocal(external.root, 'add', 'app', 'Roadmap item', '--criterion', 'remain open', '--specs', 'G1');
  const externalAgent = await external.cliLocal(external.root, 'worktree', 'app', '--model', 'fixture-agent');
  const box = await httpBox(t, { additionalProjects: [{ root: external.root, name: 'Roadmap fixture' }] });
  // The roadmap resolves other repos through this machine's registry, as an export does.
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  registerProject(external.root);
  const boardListing = await box.call('/api/v1/boards');
  const externalId = boardListing.document.boards.find((entry) => resolve(entry.root) === resolve(external.root)).id;
  const configPath = join(box.root, 'pullboard.json');
  const specPath = join(box.root, 'SPEC.md');
  const doctrinePath = join(box.root, 'DOCTRINE.md');
  await box.cliLocal(box.root, 'milestone', 'add', 'External work', '--reason', 'Arrange fixture release', '--items', `Roadmap fixture#${externalAdded.item.item_id}`);
  await box.cliLocal(box.root, 'shout', 'all', 'mark this after the stream starts');
  const agent = await box.cliLocal(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const leaseItem = (await box.cliLocal(box.root, 'add', 'app', 'Expiring stream claim', '--criterion', 'becomes open', '--specs', 'G1')).item;
  const localClaim = await box.call(box.path + '/moves', { verb: 'claim', item: leaseItem.item_id, agent: agent.agent });
  assert.equal(localClaim.status, 200);
  const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const db = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.db.prepare('UPDATE item SET item_lease_until = ? WHERE item_id = ?')
      .run(leaseUntil, leaseItem.item_id);
  } finally { store.closeBoard(db); }
  const clockNow = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clockNow });
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, {
    headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let buffered = '';
  let pendingFrame;
  let closing = false;
  let streamClosed = false;
  /** Stop the live response and settle any pending frame read on both pass and failure paths. */
  async function closeStream() {
    if (streamClosed) return;
    streamClosed = true;
    closing = true;
    controller.abort();
    await reader.cancel().catch(() => {});
    await pendingFrame?.catch(() => {});
  }
  t.after(closeStream);
  /** Read and parse the next complete server-sent-event frame. */
  async function readFrame() {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (raw.startsWith(':')) continue;
        const event = /^event: (.+)$/m.exec(raw)?.[1] ?? 'message';
        const id = /^id: (\d+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (data !== undefined) return { event, id: id === undefined ? null : Number(id), data: JSON.parse(data) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done && closing) return { event: 'closed', id: null, data: null };
      assert.equal(done, false, 'the live stream remains open while the board is served');
      buffered += new TextDecoder().decode(value);
    }
  }
  /** Share a pending frame read across timeouts so a quiet-period check cannot consume a later frame. */
  function nextFrame() {
    if (!pendingFrame) pendingFrame = readFrame().finally(() => { pendingFrame = null; });
    return pendingFrame;
  }
  /** Require an unchanged view to remain silent for longer than one server poll. */
  async function quietPeriod() {
    const extra = await Promise.race([nextFrame().then((value) => ({ value })), new Promise((resolve) => realSetTimeout(() => resolve(null), 350))]);
    assert.equal(extra, null, 'a quiet interval produces no duplicate or unrelated frame');
  }
  /** Require exactly one changed notification for the most recent input change. */
  async function changedOnce(label) {
    const frame = await Promise.race([
      nextFrame(),
      new Promise((_, reject) => realSetTimeout(() => reject(new Error(`changed event did not arrive within two seconds (${label})`)), 2000)), // budget: #554's criterion bounds a changed event at two seconds.
    ]);
    assert.equal(frame.event, 'changed');
    assert.equal(frame.id, null, 'a state notification does not advance the append-only event cursor');
    assert.deepEqual(frame.data, { version: 1, event: { event_kind: 'changed' } });
    await quietPeriod();
  }

  await quietPeriod();

  writeFileSync(specPath, readFileSync(specPath, 'utf8') + '\nThe served board follows this file.\n');
  await changedOnce('SPEC.md');

  writeFileSync(doctrinePath, '# Doctrine\n\nKeep the board honest.\n');
  await changedOnce('DOCTRINE.md');

  writeFileSync(configPath, JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')), null, 2) + '\n');
  await changedOnce('pullboard.json');

  // Committing the edited files moves HEAD alone: their bytes and stats are already seen.
  runFixtureGit(['commit', '-q', '-m', 'chore(test): move fixture head', '--', 'SPEC.md', 'DOCTRINE.md', 'pullboard.json'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  await changedOnce('head');

  const externalClaim = await box.call('/api/v1/boards/' + externalId + '/moves', { verb: 'claim', item: externalAdded.item.item_id, agent: externalAgent.agent });
  assert.equal(externalClaim.status, 200);
  await changedOnce('external-claim');

  const unavailableRoot = external.root + '.temporarily-unavailable';
  renameSync(external.root, unavailableRoot);
  await changedOnce('external-unavailable');
  renameSync(unavailableRoot, external.root);
  await changedOnce('external-restored');

  await box.cliLocal(box.root, 'shout', 'app', 'unread by the joined agent'); assert.equal((await nextFrame()).data.event.event_kind, 'shout'); await changedOnce('unread-shout-state'); // the inbox advances its cursor only past an unread shout
  const localBoardPath = join(box.root, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const cursorBefore = store.openBoard(localBoardPath);
  let beforeSeen;
  let beforeEvent;
  let beforeHistory;
  let deliveryEvent;
  try {
    beforeSeen = store.listAgents(cursorBefore).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    beforeEvent = cursorBefore.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    beforeHistory = cursorBefore.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  } finally { store.closeBoard(cursorBefore); }
  await box.cliLocal(agent.path, 'inbox');
  // @pullboard-board-file journey: the inbox HTTP view and the CLI read this same repo board file.
  const cursorAfter = store.openBoard(localBoardPath);
  try {
    const afterSeen = store.listAgents(cursorAfter).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    const afterEvent = cursorAfter.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    assert.ok(afterSeen > beforeSeen, 'the joined agent inbox advances its shout cursor');
    const delivered = cursorAfter.db.prepare('SELECT event_by,event_kind,item_id,event_detail FROM event WHERE event_id>? ORDER BY event_id').all(beforeEvent);
    deliveryEvent = { ...cursorAfter.db.prepare('SELECT * FROM event WHERE event_id=?').get(afterEvent) };
    assert.equal(afterEvent, beforeEvent + 1, 'inbox records exactly its landed native delivery receipt');
    assert.deepEqual(delivered.map(row => ({ by: row.event_by, kind: row.event_kind, item: row.item_id, detail: JSON.parse(row.event_detail) })), [{
      by: agent.agent, kind: 'activity-delivered', item: null,
      detail: { interrupts: [], through: beforeEvent, observedThrough: beforeEvent, digestThrough: beforeEvent, model: 'fixture-agent' },
    }], 'only the attributed receipt for the observed prefix is appended, without an acknowledgement or item move');
    assert.deepEqual(cursorAfter.db.prepare('SELECT * FROM event WHERE event_id<=? ORDER BY event_id').all(beforeEvent), beforeHistory,
      'the delivered receipt never rewrites the existing native history');
  } finally { store.closeBoard(cursorAfter); }
  const deliveryFrame = await nextFrame();
  assert.equal(deliveryFrame.event, 'message', 'the appended native delivery receipt travels before its state notification');
  assert.equal(deliveryFrame.id, deliveryEvent.event_id, 'the receipt advances the append-only stream cursor exactly once');
  assert.deepEqual(deliveryFrame.data, { version: 1, event: deliveryEvent }, 'the stream carries the complete actual native receipt');
  await changedOnce('seen-cursor');

  t.mock.timers.tick(Date.parse(leaseUntil) - clockNow + 1);
  await changedOnce('lease-expiry');

  // Process-level: the mocked clock is past the lease here, so an in-process command would sweep the claim first; a child keeps the real clock.
  const evented = box.cli(box.root, 'add', 'app', 'Event plus state notification', '--criterion', 'both frames arrive', '--specs', 'G1');
  const eventFrame = await nextFrame();
  assert.equal(eventFrame.event, 'message');
  assert.equal(eventFrame.data.event.event_kind, 'add');
  assert.equal(eventFrame.data.event.item_id, evented.item.item_id);
  const placementFrame = await nextFrame();
  assert.equal(placementFrame.event, 'message');
  assert.equal(placementFrame.data.event.event_kind, 'milestone_placed');
  assert.equal(placementFrame.data.event.item_id, evented.item.item_id);
  await changedOnce('ordinary-event-state');

  await closeStream();
});

/** Read a many-board event id as one cursor per board. */
function boardCursorMap(id) {
  return Object.fromEntries(id.split(',').map((pair) => {
    const [, board, sequence] = /^(.+):(\d+)$/.exec(pair);
    return [board, Number(sequence)];
  }));
}

test('[A2, N26] one event stream serves many boards', async (t) => {
  const other = fixture(t);
  const box = await httpBox(t, { additionalProjects: [{ root: other.root, name: 'Second fixture' }] });
  const listing = await box.call('/api/v1/boards');
  const otherId = listing.document.boards.find((entry) => resolve(entry.root) === resolve(other.root)).id;
  const boards = [box.id, otherId];
  const latest = async (id) => (await box.call('/api/v1/boards/' + id + '/events')).document.events.at(-1).event_id;
  const start = { [box.id]: await latest(box.id), [otherId]: await latest(otherId) };
  const headers = { 'x-pullboard-key': box.key };
  const many = box.origin + '/api/v1/events?boards=' + boards.join(',');
  /** A frame of this kind for this board, and for one item when given. */
  const is = (event, board, item) => (frame) => frame.event === event && frame.data.board === board
    && (item === undefined || frame.data.event.item_id === item);
  const message = (board, item, kind) => frame => is('message', board, item)(frame) && frame.data.event.event_kind === kind;

  const first = await liveFrames(t, many + '&after=' + encodeURIComponent(boards.map((id) => id + ':' + start[id]).join(',')), headers);
  await first.quiet('both boards unchanged');

  // A move on each board arrives on the one connection, tagged with that board, with its changed signal.
  const moves = [];
  let lastId = null;
  for (const [board, cli, root] of [[box.id, box.cliLocal, box.root], [otherId, other.cliLocal, other.root]]) {
    const added = (await cli(root, 'add', 'app', 'Move on ' + board, '--criterion', 'arrives tagged', '--specs', 'G1')).item;
    const frames = await first.until(board, message(board, added.item_id, 'add'), message(board, added.item_id, 'milestone_placed'), is('changed', board));
    assert.deepEqual(frames.map((frame) => frame.data.board), frames.map(() => board), 'every frame names the board that moved');
    const event = frames.find((frame) => frame.event === 'message');
    assert.equal(event.data.version, 1);
    assert.equal(event.data.event.event_kind, 'add');
    const placement = frames.find(frame => message(board, added.item_id, 'milestone_placed')(frame));
    lastId = placement.id;
    assert.equal(boardCursorMap(lastId)[board], placement.data.event.event_id, 'the id carries this board at its new sequence');
    assert.deepEqual(Object.keys(boardCursorMap(lastId)).sort(), [...boards].sort(), 'the id carries one cursor per followed board');
    moves.push(placement.data.event.event_id);
    await first.quiet('after the move on ' + board);
  }
  assert.deepEqual(boardCursorMap(lastId), { [box.id]: moves[0], [otherId]: moves[1] });

  // An edit that writes no event sends the changed signal for that board alone, with no id.
  writeFileSync(join(other.root, 'SPEC.md'), readFileSync(join(other.root, 'SPEC.md'), 'utf8') + '\nThe second board follows this file.\n');
  const edited = await first.until('eventless edit', is('changed', otherId));
  assert.deepEqual(edited.map(({ event, id, data }) => ({ event, id, data })), [
    { event: 'changed', id: null, data: { version: 1, board: otherId, event: { event_kind: 'changed' } } },
  ]);
  await first.quiet('after the eventless edit');
  await first.close();

  // Resuming from the last id picks up each board where it left off, and nothing earlier.
  const missed = [
    (await box.cliLocal(box.root, 'add', 'app', 'Missed on the first board', '--criterion', 'replays', '--specs', 'G1')).item.item_id,
    (await other.cliLocal(other.root, 'add', 'app', 'Missed on the second board', '--criterion', 'replays', '--specs', 'G1')).item.item_id,
  ];
  const resumed = await liveFrames(t, many, { ...headers, 'last-event-id': lastId });
  const replay = await resumed.until('resume', message(box.id, missed[0], 'add'), message(box.id, missed[0], 'milestone_placed'),
    message(otherId, missed[1], 'add'), message(otherId, missed[1], 'milestone_placed'));
  assert.deepEqual(replay.map((frame) => [frame.event, frame.data.board, frame.data.event.event_kind, frame.data.event.item_id]), [
    ['message', box.id, 'add', missed[0]], ['message', box.id, 'milestone_placed', missed[0]],
    ['message', otherId, 'add', missed[1]], ['message', otherId, 'milestone_placed', missed[1]],
  ], 'the resume replays only what each board wrote after its cursor');
  assert.deepEqual(boardCursorMap(replay.at(-1).id), { [box.id]: replay[1].data.event.event_id, [otherId]: replay[3].data.event.event_id });
  await resumed.quiet('after the resume');
  await resumed.close();

  // A board the caller cannot read is refused by name, and nothing streams.
  const missing = 'f'.repeat(32);
  const refused = await box.call('/api/v1/events?boards=' + box.id + ',' + missing, undefined, { accept: 'text/event-stream' });
  assert.equal(refused.status, 404);
  assert.equal(refused.document.error.code, 'NO_BOARD');
  assert.match(refused.document.error.message, new RegExp(missing));
  const repeated = await box.call('/api/v1/events?boards=' + box.id + ',' + box.id, undefined, { accept: 'text/event-stream' });
  assert.equal(repeated.status, 400);
  assert.match(repeated.document.error.message, new RegExp(box.id));
});


test('[C7] a fresh seat first inbox on a board of 100k events answers under 300 ms and later reads are unchanged', (t) => {
  const box = largeBoard(t);
  box.beforeCleanup(() => {
    for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
      const place = residentSocket(box.repo, PULLBOARD_ENTRY, slot);
      if (!place) continue;
      try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
    }
  });
  // The resident board process serves the board commands, as on a person's machine; test markers would turn it off.
  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete box.env[name];
  box.env.PULLBOARD_RESIDENT = '1';
  // The seat joins after the board is seeded, as a new worker does; it has not yet read its inbox.
  const seat = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
  const joined = joinFixtureSeat(box, seat, 'web');
  assert.equal(joined.code, 0, `${joined.err}${joined.out}`);
  // Two untimed commands start and warm the resident process.
  const timed = (command = 'inbox') => {
    const started = performance.now();
    const result = box.run(seat, command, '--json');
    return { ms: performance.now() - started, result };
  };
  for (let run = 0; run < 2; run += 1) assert.equal(timed('status').result.code, 0);
  const first = timed();
  assert.equal(first.result.code, 0, first.result.err + first.result.out);
  assert.ok(first.ms < 300, `the first inbox took ${first.ms.toFixed(0)} ms, over its 300 ms budget`);
  const document = JSON.parse(first.result.out);
  assert.deepEqual(document.activity.interrupts, [], 'nothing from before the seat joined is owed to it');
  const second = timed();
  assert.equal(second.result.code, 0, second.result.err + second.result.out);
  assert.match(second.result.out, /no new shouts or activity|"shouts": \[\]/u);
});
