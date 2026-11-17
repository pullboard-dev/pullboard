/** @pullboard-world-pin reads the recorded submit history fixture to drive the submit commit writer with it. The store submit writer applies the COMMIT table and agrees on every replayed move [C7,#8281]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/submit-history.json packages/store/src/io/submission.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmissionEvent } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { recorded } from '../../../../../store/tests/fixtures/submit-history.js';

const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board holding the one claimed item a recorded submit saw, on a clock at the submit's own instant. */
function boardFor(t, snapshot) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', 'claimed', ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, item.owner, item.leaseUntil, item.frozenDigest, STAMP, STAMP);
  return board;
}

/** Run the writer on a board that shadows it, with the recorded gate result and proof the replay captured. */
function drive(board, record) {
  const seen = [];
  board.submitCommitShadow = (answer) => seen.push(answer);
  const { gate, deferred } = record.snapshot;
  const { id, actor, commit, tree, note, infra, companionRecord, quarantineProofIds } = record.move;
  recordSubmissionEvent(board, id, { agentId: actor, commit, tree, policyCommit: gate.policyCommit, note, recordedProof: deferred.proofRecord ?? undefined, infra, tooling: gate.tooling,
    modern: true, gateGreen: gate.green, companion: companionRecord, quarantineProofIds, carry: false, recordedSize: gate.size, engineVersion: 9 });
  assert.equal(seen.length, 1, 'the writer ran the table once');
  return seen[0];
}

const { records } = recorded();
const commits = records.filter(record => record.table === 'COMMIT');

test('clause 1: the store submit commit writer applies the COMMIT table and agrees on every replayed move [C7,#8281]', t => {
  assert.equal(commits.length, 6, 'the replay holds the board\'s six submits');
  for (const record of commits) {
    const seen = drive(boardFor(t, record.snapshot), record);
    assert.deepEqual(seen.decided, seen.wrote, `the table writes what the writer logged at event ${record.event.id}`);
    assert.deepEqual(seen.wrote, record.recorded.events.map(({ kind, by, detail }) => ({ kind, by, detail })), `the writer logs what the board recorded at event ${record.event.id}`);
  }
});

test('clause 1: a board without the hook logs the same submit and runs no table [C7,#8281]', t => {
  const [record] = commits;
  const board = boardFor(t, record.snapshot);
  const { gate, deferred } = record.snapshot;
  const { id, actor, commit, tree } = record.move;
  recordSubmissionEvent(board, id, { agentId: actor, commit, tree, policyCommit: gate.policyCommit, recordedProof: deferred.proofRecord ?? undefined, modern: true, gateGreen: gate.green, engineVersion: 9 });
  const { n } = board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='submit'").get();
  assert.equal(n, 1);
});
