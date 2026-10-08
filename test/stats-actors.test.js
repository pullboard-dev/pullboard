/** Event statistics attribute only recorded actor-family evidence, never current declarations [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, claim, closeBoard, events, openBoard, register, release } from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { eventCounts, proofStats } from '../src/stats.js';

/** Create a private in-memory board with a controllable clock and its two real actors. */
function fixture(t) {
  let at = new Date('2026-02-01T00:00:00.000Z');
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => closeBoard(board));
  /** Advance the deterministic event clock. */
  const setTime = (value) => { at = new Date(value); };
  setTime('2026-02-01T00:00:00.000Z');
  register(board, { lane: 'coordinator', path: '/actors/coordinator' });
  setTime('2026-02-01T00:01:00.000Z');
  register(board, { lane: 'web', path: '/actors/web-builder', family: 'legacy-family' });
  return { board, setTime };
}

/** Add one open web item using the coordinator's public board operation. */
function addWebItem(f, title, at) {
  f.setTime(at);
  return addItem(f.board, { by: 'coordinator', lane: 'web', title, criterion: 'actor events are counted' });
}

/** Claim and return an item to open so a later action can exercise another event snapshot. */
function claimAndRelease(f, id, claimAt, releaseAt) {
  f.setTime(claimAt);
  claim(f.board, id, {
    agentId: 'web-1', lane: 'web', leaseMs: 86_400_000,
    freeze: () => ({ text: 'A stable actor fixture criterion.', digest: 'actor-fixture-digest' }),
  });
  f.setTime(releaseAt);
  release(f.board, id, 'web-1');
}

/** Build a legacy history before a family change and ordinary moves after that declaration. */
function familyHistory(t) {
  const f = fixture(t);
  const first = addWebItem(f, 'Before family event', '2026-02-02T10:00:00.000Z');
  claimAndRelease(f, first, '2026-02-02T11:00:00.000Z', '2026-02-02T12:00:00.000Z');
  f.setTime('2026-02-03T10:00:00.000Z');
  register(f.board, { lane: 'web', path: '/actors/web-builder', family: 'new-family' });
  const second = addWebItem(f, 'After family event one', '2026-02-04T10:00:00.000Z');
  claimAndRelease(f, second, '2026-02-04T11:00:00.000Z', '2026-02-04T12:00:00.000Z');
  const third = addWebItem(f, 'After family event two', '2026-02-05T10:00:00.000Z');
  claimAndRelease(f, third, '2026-02-05T11:00:00.000Z', '2026-02-05T12:00:00.000Z');
  // Emulate the legacy event format even if future joins begin capturing family snapshots.
  const document = exportBoard(f.board);
  for (const event of document.tables.event) {
    if (event.event_kind === 'family') continue;
    const detail = JSON.parse(event.event_detail);
    delete detail.family;
    event.event_detail = JSON.stringify(detail);
  }
  return { ...f, board: importedBoard(t, document) };
}

/** Read an event detail from an exported private document. */
function detailOf(event) {
  return JSON.parse(event.event_detail);
}

/** Set a recorded family snapshot on one copied event without changing the live board. */
function setSnapshot(event, family) {
  event.event_detail = JSON.stringify({ ...detailOf(event), family });
}

/** Import a modified native document into a separate private in-memory board. */
function importedBoard(t, document) {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  importBoard(board, document);
  return board;
}

/** Add one historical system-actor event to an exported document and its sequence counter. */
function appendSystemEvent(document, event) {
  const eventId = Math.max(0, ...document.tables.event.map((row) => row.event_id)) + 1;
  document.tables.event.push({ event_id: eventId, item_id: null, ...event });
  const counter = document.tables.sqlite_sequence.find((row) => row.name === 'event');
  if (counter) counter.seq = eventId;
}

/** Keep the pre-existing event counts identical when actor dimensions are added. */
function assertCountsUnchanged(board, stats, options) {
  const counts = eventCounts(board, options);
  for (const key of ['since', 'submissions', 'rejections', 'rejectionShare', 'merged', 'mergedWithoutAccept', 'firstEventAt', 'lastEventAt']) {
    assert.deepEqual(stats[key], counts[key], `${key} stays the same as eventCounts`);
  }
}

test('[R1,R2] legacy family declarations are unknown until a family event and do not backfill', (t) => {
  const { board } = familyHistory(t);
  const stats = proofStats(board);
  assert.equal(board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get('web-1').agent_family, 'new-family',
    'the current declaration is newer than the initial events');
  assert.deepEqual(stats.agents, [
    { id: 'coordinator', moves: 4, families: ['unknown'] },
    { id: 'web-1', moves: 8, families: ['new-family', 'unknown'] },
  ]);
  assert.deepEqual(stats.families, [
    { name: 'new-family', agents: 1, moves: 5 },
    { name: 'unknown', agents: 2, moves: 7 },
  ]);
  assert.equal(stats.agentCount, 2);
  assert.equal(stats.familyCount, 2);
  assertCountsUnchanged(board, stats);
});

test('[R1,R2] a window keeps earlier family evidence but excludes earlier unknown-family moves', (t) => {
  const { board } = familyHistory(t);
  const since = '2026-02-04';
  const stats = proofStats(board, { since });
  assert.equal(stats.since, '2026-02-04T00:00:00.000Z');
  assert.equal(stats.agentCount, 2);
  assert.deepEqual(stats.agents, [
    { id: 'coordinator', moves: 2, families: ['unknown'] },
    { id: 'web-1', moves: 4, families: ['new-family'] },
  ], 'the pre-window family event classifies selected legacy-format moves');
  assert.deepEqual(stats.families, [
    { name: 'new-family', agents: 1, moves: 4 },
    { name: 'unknown', agents: 1, moves: 2 },
  ]);
  assert.equal(stats.familyCount, 2);
  assertCountsUnchanged(board, stats, { since });
});

test('[R1,R2] explicit snapshots override prior state, null clears it, and system actors stay excluded', (t) => {
  const { board } = familyHistory(t);
  const document = exportBoard(board);
  const history = document.tables.event;
  const actorEvents = history.filter((event) => event.event_by === 'web-1');
  const join = actorEvents.find((event) => event.event_kind === 'join');
  const firstRelease = actorEvents.filter((event) => event.event_kind === 'release')[0];
  const familyUpdate = actorEvents.find((event) => event.event_kind === 'family');
  const laterClaims = actorEvents.filter((event) => event.event_kind === 'claim').slice(1);
  const laterReleases = actorEvents.filter((event) => event.event_kind === 'release').slice(1);
  setSnapshot(join, 'join-snapshot');
  setSnapshot(firstRelease, 'move-snapshot');
  setSnapshot(laterClaims[0], null);
  setSnapshot(laterClaims[1], 'third-snapshot');
  assert.equal(detailOf(familyUpdate).family, 'new-family', 'a family-change event is itself explicit evidence');
  appendSystemEvent(document, {
    event_at: '2026-02-06T00:00:00.000Z', event_by: 'board', event_kind: 'guards', event_detail: JSON.stringify({ family: 'ignored-board' }),
  });
  appendSystemEvent(document, {
    event_at: '2026-02-06T00:01:00.000Z', event_by: 'person', event_kind: 'row_decision', event_detail: JSON.stringify({ family: 'ignored-person' }),
  });
  const imported = importedBoard(t, document);
  const stats = proofStats(imported);
  assert.deepEqual(stats.agents, [
    { id: 'coordinator', moves: 4, families: ['unknown'] },
    { id: 'web-1', moves: 8, families: ['join-snapshot', 'move-snapshot', 'new-family', 'third-snapshot', 'unknown'] },
  ]);
  assert.deepEqual(stats.families, [
    { name: 'join-snapshot', agents: 1, moves: 2 },
    { name: 'move-snapshot', agents: 1, moves: 1 },
    { name: 'new-family', agents: 1, moves: 1 },
    { name: 'third-snapshot', agents: 1, moves: 2 },
    { name: 'unknown', agents: 2, moves: 6 },
  ]);
  assert.equal(stats.agentCount, 2, 'board and person are system actors, not agents');
  assert.equal(stats.familyCount, 5);
  assertCountsUnchanged(imported, stats);
  assert.ok(laterReleases.length === 2, 'both later missing-snapshot moves inherit the previous explicit evidence');
  assert.equal(events(imported).filter((event) => ['board', 'person'].includes(event.event_by)).length, 2);
});

test('[R1,R2] an empty board reports no agents or family buckets', (t) => {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  assert.deepEqual(proofStats(board), {
    since: null,
    submissions: 0,
    rejections: 0,
    rejectionShare: 0,
    merged: 0,
    mergedWithoutAccept: 0,
    firstEventAt: null,
    lastEventAt: null,
    agentCount: 0,
    familyCount: 0,
    agents: [],
    families: [],
  });
});
