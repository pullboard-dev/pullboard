/** HTTP event stream says when the board changes and serves many boards [A2,N26]. */
import assert from 'node:assert/strict';

import {
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';

import { registerProject } from '../../../../packages/seats/index.js';

import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fetchFresh } from '../../tests/fixtures/http.js';

import { liveFrames } from '../../tests/fixtures/http/stream.js';

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
