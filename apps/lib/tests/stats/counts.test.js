/** Event-derived submission, rejection and merge counts preserve historical acceptance proof [R1,R2]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitFixture } from '../../../cli/tests/fixtures/board/submit.js';
import { addItem } from '../../../../packages/store/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { claim } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { register } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { restoreRelaySnapshot } from '../../../../packages/store/index.js';
import { semanticBoardDigest } from '../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { proofStats as legacyProofStats } from '../fixtures/legacy.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { eventCounts } from '../../../../packages/stats/index.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


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
  submitFixture(f.board, id, { agentId: 'web-1', commit, tree });
}

/** Record an accept or reject from a different registered reviewer. */
function verdictAt(f, id, decision, commit, at) {
  f.setTime(at);
  return verify(f.board, id, {
    agentId: 'web-2', decision,
    ...(decision === 'REJECT' ? { reason: 'TEST_FAILURE', clause: 'The fixture lifecycle remains auditable.' } : {}),
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

/** Commit a writer between the reader's cursor and shard queries on a real WAL database. */
function concurrentCounterRead(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-stats-snapshot-'));
  const path = join(directory, 'board.sqlite');
  // @pullboard-board-file locking: a reader and a writer connection share one file to observe a snapshot
  const reader = openBoard(path);
  // @pullboard-board-file locking: a reader and a writer connection share one file to observe a snapshot
  const writer = openBoard(path);
  t.after(() => { closeBoard(writer); closeBoard(reader); rmSync(directory, { recursive: true }); });
  register(writer, { lane: 'coordinator', path: '/fixture/concurrent-coordinator' });
  const id = addItem(writer, { by: 'coordinator', lane: 'web', title: 'Concurrent stats', criterion: 'one snapshot' });
  const options = { now: Date.parse('2027-01-01T00:00:00Z') };
  const before = legacyProofStats(reader, options);
  let injected = false;
  const db = new Proxy(reader.db, {
    /** Bind native SQLite methods and insert the concurrent write at the chosen read boundary. */
    get(target, key) {
      if (key === 'prepare') return sql => {
        const statement = target.prepare(sql);
        if (!sql.includes('coalesce(max(event_id),0)')) return statement;
        return new Proxy(statement, {
          /** Return the old cursor after the second connection has committed its new event. */
          get(native, method) {
            if (method === 'get') return (...args) => {
              const row = native.get(...args);
              if (!injected) { injected = true; logEvent(writer, 'coordinator', 'submit', id, { commit: COMMIT_ONE }); }
              return row;
            };
            const value = Reflect.get(native, method, native);
            return typeof value === 'function' ? value.bind(native) : value;
          },
        });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  reader.db.exec('PRAGMA query_only=ON');
  assert.deepEqual(proofStats({ ...reader, db }, options, statsReadPorts), before, 'one response must use one SQLite read snapshot');
  assert.equal(injected, true, 'the second connection actually committed between the reader queries');
  assert.deepEqual(proofStats(reader, options, statsReadPorts), legacyProofStats(writer, options), 'the next response observes the committed event');
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
  const counts = eventCounts(board, {}, statsReadPorts);
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
  assert.deepEqual(eventCounts(board, { since: '2026-01-05' }, statsReadPorts), {
    since: '2026-01-05T00:00:00.000Z',
    submissions: 1,
    rejections: 0,
    rejectionShare: 0,
    merged: 1,
    mergedWithoutAccept: 0,
    firstEventAt: '2026-01-05T10:00:00.000Z',
    lastEventAt: '2026-01-08T10:00:00.000Z',
  });
  assert.deepEqual(eventCounts(board, { since: '2026-01-07T10:00:00Z' }, statsReadPorts), {
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
  assert.deepEqual(eventCounts(board, { since: '2026-02-01' }, statsReadPorts), {
    since: '2026-02-01T00:00:00.000Z',
    submissions: 0,
    rejections: 0,
    rejectionShare: 0,
    merged: 0,
    mergedWithoutAccept: 0,
    firstEventAt: null,
    lastEventAt: null,
  });
  assert.throws(() => eventCounts(board, { since: '2026-02-30' }, statsReadPorts), { code: 'BAD_SINCE' });
  assert.throws(() => eventCounts(board, { since: '2026-01-07T10:00:00+00:00' }, statsReadPorts), { code: 'BAD_SINCE' });
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
  assert.equal(eventCounts(missingBoard, {}, statsReadPorts).mergedWithoutAccept, 1, 'the merge is anomalous when its accept event is absent');

  const wrongAccept = structuredClone(original);
  const wrongEvent = wrongAccept.tables.event.find((event) => event.item_id === id && event.event_kind === 'accept');
  wrongEvent.event_detail = JSON.stringify({ ...JSON.parse(wrongEvent.event_detail), commit: 'f'.repeat(40) });
  const wrongBoard = importedBoard(t, wrongAccept);
  assert.equal(getItem(wrongBoard, id).item_status, 'verified');
  assert.equal(eventCounts(wrongBoard, {}, statsReadPorts).mergedWithoutAccept, 1, 'a different accepted commit does not prove the merged submission');

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
  assert.equal(eventCounts(staleBoard, {}, statsReadPorts).mergedWithoutAccept, 1,
    'a new submit invalidates a previously accepted commit even when the current row remains verified');
});


test('[R1,R2,C7] proof stats counters match a full re-parse after every event', t => {
  const f = fixture(t);
  const { board } = f;
  let parsed = [];
  board.onProofStatsEvent = event => parsed.push(event.event_id);
  let id;
  /** Compare independent full-history results at the same observation time and several windows. */
  const same = current => {
    const now = Date.parse('2026-02-01T00:00:00Z');
    for (const since of [undefined, '2026-01-04', '2026-01-20']) {
      assert.deepEqual(proofStats(current, { since, now }, statsReadPorts), legacyProofStats(current, { since, now }));
    }
  };
  const steps = [
    () => { id = addAndClaim(f, 'Incrementally counted lifecycle'); },
    () => submitAt(f, id, COMMIT_ONE, TREE_ONE, '2026-01-03T10:00:00Z'),
    () => verdictAt(f, id, 'REJECT', COMMIT_ONE, '2026-01-04T10:00:00Z'),
    () => { f.setTime('2026-01-04T11:00:00Z'); claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 86_400_000, freeze: freezeCriterion }); },
    () => submitAt(f, id, COMMIT_TWO, TREE_TWO, '2026-01-05T10:00:00Z'),
    () => verdictAt(f, id, 'ACCEPT', COMMIT_TWO, '2026-01-06T10:00:00Z'),
    () => { f.setTime('2026-01-07T10:00:00Z'); merged(board, id, { agentId: 'coordinator', commit: MAIN_MERGE }); },
    () => logEvent(board, 'web-1', 'join', null, { lane: 'web', family: 'changed-family' }),
    () => logEvent(board, 'coordinator', 'edit', id, { reason: 'the original bar was wrong', barCorrection: { fields: ['check'], reject: { verdict: 1 } } }),
    () => logEvent(board, 'coordinator', 'reopen', id, { conflict: { files: ['src/example.js'] } }),
    () => logEvent(board, 'coordinator', 'refreeze', id, {}),
    () => logEvent(board, 'web-2', 'reject', id, { commit: COMMIT_ONE, reason: 'TEST_FAILURE' }),
    () => logEvent(board, 'coordinator', 'merged', id, { commit: MAIN_MERGE }),
    () => logEvent(board, 'coordinator', 'test-quarantine', null, { file: 'test/example.test.js', name: 'a historical flake', tree: TREE_ONE }),
    () => logEvent(board, 'sentinel', 'health-failure', null, { subject: 'unresolved obligation', cause: 'refusal:STUCK' }),
  ];
  for (const step of steps) {
    const previous = events(board).at(-1)?.event_id ?? 0;
    parsed = [];
    step();
    const appended = events(board).filter(event => event.event_id > previous).map(event => event.event_id);
    assert.deepEqual(parsed, appended, 'each appended event is decoded once into its counters');
    same(board);
    assert.deepEqual(parsed, appended, 'reading counters never reparses earlier event details');
  }
  const document = exportBoard(board);
  assert.equal(document.tables.board_meta.some(row => row.meta_key.startsWith('local:proof-stats:')), false,
    'derived counters are not native exported state');
  const restored = importedBoard(t, document);
  same(restored);
  const restoredParses = [];
  restored.onProofStatsEvent = event => restoredParses.push(event.event_id);
  logEvent(restored, 'web-1', 'shout', null, {});
  assert.deepEqual(restoredParses, [events(restored).at(-1).event_id], 'restored counters continue with one new event');
  same(restored);
  const replacement = exportBoard(board);
  const changedJoin = replacement.tables.event.find(event => event.event_kind === 'join' && event.event_by === 'web-1');
  changedJoin.event_detail = JSON.stringify({ ...JSON.parse(changedJoin.event_detail), family: 'restored-family' });
  const semantic = semanticBoardDigest(replacement);
  replacement.tables.board_meta.push({ meta_key: 'local:proof-stats:v1:summary', meta_value: 'untrusted supplied projection' });
  assert.equal(semanticBoardDigest(replacement), semantic, 'native digests ignore local projections');
  replacement.tables.board_meta.push({ meta_key: 'relay_applied_sequence', meta_value: '1' },
    { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION) });
  restoreRelaySnapshot(board, replacement, 1);
  same(board);
  board.db.exec('PRAGMA query_only=ON');
  try { same(board); }
  finally { board.db.exec('PRAGMA query_only=OFF'); }
  const before = proofStats(board, { now: 1_770_000_000_000 }, statsReadPorts);
  assert.throws(() => atomic(board, () => {
    logEvent(board, 'web-1', 'submit', id, { commit: 'f'.repeat(40) });
    throw new Error('rollback fixture');
  }), /rollback fixture/u);
  assert.deepEqual(proofStats(board, { now: 1_770_000_000_000 }, statsReadPorts), before, 'rollback preserves the prior projection');
  concurrentCounterRead(t);
});
