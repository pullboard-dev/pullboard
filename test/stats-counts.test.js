/** Event-derived submission, rejection and merge counts preserve historical acceptance proof [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, claim, closeBoard, getItem, merged, openBoard, register, submit, verify } from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { eventCounts } from '../src/stats.js';

const COMMIT_ONE = '1'.repeat(40);
const COMMIT_TWO = '2'.repeat(40);
const MAIN_MERGE = 'a'.repeat(40);
const TREE_ONE = 'tree-one';
const TREE_TWO = 'tree-two';

/** Create a real SQLite board with a mutable deterministic clock and close it after the test. */
function fixture(t) {
  let at = new Date('2026-01-01T00:00:00.000Z');
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => closeBoard(board));
  /** Advance the deterministic board clock for the next public lifecycle move. */
  const setTime = (value) => { at = new Date(value); };
  setTime('2026-01-01T00:00:00.000Z');
  register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  setTime('2026-01-01T00:01:00.000Z');
  register(board, { lane: 'web', path: '/fixture/web-builder', family: 'builder-family' });
  setTime('2026-01-01T00:02:00.000Z');
  register(board, { lane: 'web', path: '/fixture/web-reviewer', family: 'review-family' });
  return { board, setTime };
}

/** Freeze a stable criterion for every claim and rework in these lifecycle fixtures. */
function freezeCriterion() {
  return { text: 'The fixture lifecycle remains auditable.', digest: 'fixture-criterion-digest' };
}

/** Add and claim one item as its builder at the requested deterministic time. */
function addAndClaim(f, title) {
  f.setTime('2026-01-02T00:00:00.000Z');
  const id = addItem(f.board, { by: 'coordinator', lane: 'web', title, criterion: 'the history is counted' });
  f.setTime('2026-01-02T01:00:00.000Z');
  claim(f.board, id, { agentId: 'web-1', lane: 'web', leaseMs: 86_400_000, freeze: freezeCriterion });
  return id;
}

/** Submit one immutable commit after the builder holds its claim. */
function submitAt(f, id, commit, tree, at) {
  f.setTime(at);
  submit(f.board, id, { agentId: 'web-1', commit, tree });
}

/** Record an accept or reject from a different registered reviewer. */
function verdictAt(f, id, decision, commit, at) {
  f.setTime(at);
  return verify(f.board, id, {
    agentId: 'web-2', decision,
    ...(decision === 'REJECT' ? { reason: 'TEST_FAILURE' } : {}),
    note: decision === 'REJECT' ? 'the first result fails; rework is needed' : 'rework is verified against the frozen criterion',
    head: commit,
    digest: 'fixture-criterion-digest',
    policy: 'any',
  });
}

/** Build a valid reject, rework, accept, and repeated-merge history on a private board. */
function rejectedThenMerged(t) {
  const f = fixture(t);
  const id = addAndClaim(f, 'Rejected then merged');
  submitAt(f, id, COMMIT_ONE, TREE_ONE, '2026-01-03T10:00:00.000Z');
  verdictAt(f, id, 'REJECT', COMMIT_ONE, '2026-01-04T10:00:00.000Z');
  f.setTime('2026-01-04T11:00:00.000Z');
  claim(f.board, id, { agentId: 'web-1', lane: 'web', leaseMs: 86_400_000, freeze: freezeCriterion });
  submitAt(f, id, COMMIT_TWO, TREE_TWO, '2026-01-05T10:00:00.000Z');
  verdictAt(f, id, 'ACCEPT', COMMIT_TWO, '2026-01-06T10:00:00.000Z');
  f.setTime('2026-01-07T10:00:00.000Z');
  merged(f.board, id, { agentId: 'coordinator', commit: MAIN_MERGE });
  f.setTime('2026-01-08T10:00:00.000Z');
  merged(f.board, id, { agentId: 'coordinator', commit: 'b'.repeat(40) });
  return { ...f, id };
}

/** Import a copied native board document into a fresh private in-memory SQLite board. */
function importedBoard(t, document) {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  importBoard(board, document);
  return board;
}

/** Re-number an edited private event history and its SQLite AUTOINCREMENT counter. */
function resequenceEvents(document, history) {
  document.tables.event = history
    .sort((first, second) => Date.parse(first.event_at) - Date.parse(second.event_at))
    .map((event, index) => ({ ...event, event_id: index + 1 }));
  const counter = document.tables.sqlite_sequence.find((row) => row.name === 'event');
  if (counter) counter.seq = document.tables.event.length;
}

test('[R1,R2] repeated submissions and rejections count attempts while merges count distinct items', (t) => {
  const { board } = rejectedThenMerged(t);
  const counts = eventCounts(board);
  assert.deepEqual(counts, {
    since: null,
    submissions: 2,
    rejections: 1,
    rejectionShare: 0.5,
    merged: 1,
    mergedWithoutAccept: 0,
    firstEventAt: '2026-01-01T00:00:00.000Z',
    lastEventAt: '2026-01-08T10:00:00.000Z',
  });
  assert.equal(getItem(board, 1).item_status, 'verified');
});

test('[R1,R2] date and timestamp windows are inclusive and earlier acceptance still proves a merge', (t) => {
  const { board } = rejectedThenMerged(t);
  assert.deepEqual(eventCounts(board, { since: '2026-01-05' }), {
    since: '2026-01-05T00:00:00.000Z',
    submissions: 1,
    rejections: 0,
    rejectionShare: 0,
    merged: 1,
    mergedWithoutAccept: 0,
    firstEventAt: '2026-01-05T10:00:00.000Z',
    lastEventAt: '2026-01-08T10:00:00.000Z',
  });
  assert.deepEqual(eventCounts(board, { since: '2026-01-07T10:00:00Z' }), {
    since: '2026-01-07T10:00:00.000Z',
    submissions: 0,
    rejections: 0,
    rejectionShare: 0,
    merged: 1,
    mergedWithoutAccept: 0,
    firstEventAt: '2026-01-07T10:00:00.000Z',
    lastEventAt: '2026-01-08T10:00:00.000Z',
  }, 'the acceptance before the selected window remains proof for the later merge');
});

test('[R1,R2] empty windows normalize cleanly and invalid dates refuse', (t) => {
  const { board } = rejectedThenMerged(t);
  assert.deepEqual(eventCounts(board, { since: '2026-02-01' }), {
    since: '2026-02-01T00:00:00.000Z',
    submissions: 0,
    rejections: 0,
    rejectionShare: 0,
    merged: 0,
    mergedWithoutAccept: 0,
    firstEventAt: null,
    lastEventAt: null,
  });
  assert.throws(() => eventCounts(board, { since: '2026-02-30' }), { code: 'BAD_SINCE' });
  assert.throws(() => eventCounts(board, { since: '2026-01-07T10:00:00+00:00' }), { code: 'BAD_SINCE' });
});

test('[R1,R2] imported historical merges without a matching current acceptance remain anomalies', (t) => {
  const { board, id } = rejectedThenMerged(t);
  const original = exportBoard(board);
  const accepts = original.tables.event.filter((event) => event.item_id === id && event.event_kind === 'accept');
  assert.equal(accepts.length, 1);

  const missingAccept = structuredClone(original);
  missingAccept.tables.event = missingAccept.tables.event.filter((event) => !(event.item_id === id && event.event_kind === 'accept'));
  const missingBoard = importedBoard(t, missingAccept);
  assert.equal(getItem(missingBoard, id).item_status, 'verified', 'the historical item row still says verified');
  assert.equal(eventCounts(missingBoard).mergedWithoutAccept, 1, 'the merge is anomalous when its accept event is absent');

  const wrongAccept = structuredClone(original);
  const wrongEvent = wrongAccept.tables.event.find((event) => event.item_id === id && event.event_kind === 'accept');
  wrongEvent.event_detail = JSON.stringify({ ...JSON.parse(wrongEvent.event_detail), commit: 'f'.repeat(40) });
  const wrongBoard = importedBoard(t, wrongAccept);
  assert.equal(getItem(wrongBoard, id).item_status, 'verified');
  assert.equal(eventCounts(wrongBoard).mergedWithoutAccept, 1, 'a different accepted commit does not prove the merged submission');

  const staleAccept = structuredClone(original);
  const itemHistory = staleAccept.tables.event.filter((event) => event.item_id === id);
  const firstSubmit = itemHistory.find((event) => event.event_kind === 'submit' && JSON.parse(event.event_detail).commit === COMMIT_ONE);
  const secondSubmit = itemHistory.find((event) => event.event_kind === 'submit' && JSON.parse(event.event_detail).commit === COMMIT_TWO);
  const mergedEvent = itemHistory.find((event) => event.event_kind === 'merged');
  const oldAccept = {
    ...accepts[0],
    event_at: '2026-01-03T11:00:00.000Z',
    event_detail: JSON.stringify({ reason: 'CRITERION_MET', commit: COMMIT_ONE }),
  };
  const oldHistory = staleAccept.tables.event.filter((event) => event.item_id !== id || event.event_kind === 'add');
  resequenceEvents(staleAccept, [...oldHistory, firstSubmit, oldAccept, secondSubmit, mergedEvent]);
  const staleBoard = importedBoard(t, staleAccept);
  assert.equal(getItem(staleBoard, id).item_status, 'verified');
  assert.equal(eventCounts(staleBoard).mergedWithoutAccept, 1,
    'a new submit invalidates a previously accepted commit even when the current row remains verified');
});
