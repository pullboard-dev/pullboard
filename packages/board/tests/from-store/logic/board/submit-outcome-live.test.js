/** @pullboard-test-input packages/store/tests/fixtures/submit-outcome-records.json */
/** @pullboard-world-pin reads the recorded refusal renewals fixture to drive the submit outcome writer with it. With moves.live.outcome on, the writer follows the OUTCOME table; off, its own rules decide [C7,#8386]. */
/** @pullboard-test-input packages/store/tests/fixtures/submit-outcome-records.json packages/store/src/io/submit/outcome.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkedSubmitOutcome } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const outcomes = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/submit-outcome-records.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** A real board holding the one item a recorded refusal renewal saw; `live` stands in for the moves.live.outcome machine setting. */
function boardFor(t, snapshot, { live, ...over } = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(snapshot.now) });
  if (live !== undefined) board.movesLive = { outcome: live };
  board.movesShadow = false;
  const sql = board.db;
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const { item } = snapshot;
  sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(item.owner, 'core', `/seat/${item.owner}`, 'strong', STAMP);
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_frozen, item_frozen_digest, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', 'strong', ?, ?, ?, 'frozen', ?, 'coordinator', ?, ?)`)
    .run(item.id, over.status ?? item.status, over.owner ?? item.owner, over.leaseUntil ?? item.leaseUntil, over.digest ?? item.frozenDigest, STAMP, STAMP);
  return board;
}

/** The writer's answer: what it returned, or the refusal it threw. */
function write(board, record, value = record.renewal) {
  try { return { returned: checkedSubmitOutcome(board, record.move.id, record.move.actor, value, null) }; } catch (error) { return { threw: error }; }
}

test('board.submit-outcome-live.with-moves-live-outcome-submit-outcome: clause 1: with moves.live.outcome on, a submit outcome records what the outcome table decides [C7,#8386]', t => {
  for (const record of outcomes) {
    const seen = [];
    const shadow = boardFor(t, record.snapshot, { live: false });
    shadow.submitOutcomeShadow = answer => seen.push(answer);
    write(shadow, record);
    const live = write(boardFor(t, record.snapshot, { live: true }), record);
    assert.equal(live.threw, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(live.returned)), JSON.parse(JSON.stringify(seen[0].decided.recorded)));
    assert.deepEqual(JSON.parse(JSON.stringify(live.returned)), record.renewal);
  }
});

test('board.submit-outcome-live.with-moves-live-outcome-outcome-the: clause 2: with moves.live.outcome on, an outcome the table refuses is refused with the table\'s code and next step [C7,#8386]', t => {
  const [record] = outcomes;
  const bad = write(boardFor(t, record.snapshot, { live: true }), record, { ...record.renewal, code: 'lower' });
  assert.equal(bad.threw.code, 'USAGE');
  assert.ok(typeof bad.threw.next === 'string' && bad.threw.next.length > 0, 'the refusal names a next step');
  const moved = write(boardFor(t, record.snapshot, { live: true, owner: 'someone-else' }), record);
  assert.equal(moved.threw.code, 'ITEM_LEASE_LOST');
});

test('board.submit-outcome-live.with-moves-live-outcome-off-the: clause 3: with moves.live.outcome set false the writer\'s own rules decide [C7,#8386]', t => {
  const [record] = outcomes;
  const bad = write(boardFor(t, record.snapshot, { live: false }), record, { ...record.renewal, code: 'lower' });
  assert.equal(bad.threw.code, 'USAGE');
  assert.match(bad.threw.message, /retains its actual refusal code/u);
  const ok = write(boardFor(t, record.snapshot, { live: false }), record);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.returned)), record.renewal);
});
