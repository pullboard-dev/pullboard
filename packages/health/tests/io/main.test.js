/** @pullboard-test-input source-cell store board health */
/** With health.adviceThroughNext on, a claim reserved to its holder draws no rank-inversion release advice [C7,#11704]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logEvent } from '../../../store/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { healthReport } from '../../index.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const LEASE = new Date(AT + 3_600_000).toISOString();

/** A board where core-1 holds claimed item 2 while the older item 1 sits free in the same lane; `reservedTo` names the holder of item 2's reservation. */
function inversion(t, reservedTo) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(AT) } });
  const sql = board.db;
  sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run('core-1', 'core', '/seat/core-1', 'strong', STAMP);
  for (const id of [1, 2]) {
    sql.prepare("INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, 'core', ?, 'strong', 'open', 'coordinator', ?, ?)").run(id, `Item ${id}`, STAMP, STAMP);
    logEvent(board, 'coordinator', 'add', id, {});
  }
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  sql.prepare("UPDATE item SET item_status='claimed', item_owner='core-1', item_lease_until=?, item_frozen_digest=? WHERE item_id=2").run(LEASE, 'd'.repeat(64));
  if (reservedTo) sql.prepare('UPDATE item SET item_reservation_holder=?, item_reservation_by=?, item_reservation_at=? WHERE item_id=2').run(reservedTo, 'coordinator', STAMP);
  sql.exec('DELETE FROM temp.moving');
  logEvent(board, 'core-1', 'claim', 2, { leaseUntil: LEASE });
  return board;
}

/** The RANK_INVERSION findings of the health report read at the board's clock, with the given machine settings. */
function inversions(board, machineSettings) {
  const report = healthReport({ db: board.db, root: process.cwd(), config: {}, now: new Date(AT), dispatchHealth: () => ({ findings: [] }), machineSettings });
  return [...report.stuck, ...report.waiting].filter(row => row.cause === 'RANK_INVERSION');
}

test('health.io-main.reserved-claim-no-release-advice: clause 1: with health.adviceThroughNext on, a claim reserved to its holder beside a free higher-ranked item yields no RANK_INVERSION finding, and an unreserved claim beside the same item still yields one [C7,#11704]', t => {
  const on = { health: { adviceThroughNext: true } };
  assert.equal(inversions(inversion(t, 'core-1'), on).length, 0);
  assert.equal(inversions(inversion(t, null), on).length, 1);
});

test('health.io-main.reserved-claim-setting-off: clause 2: with the setting off or unset, the reserved claim yields the RANK_INVERSION finding as before [C7,#11704]', t => {
  assert.equal(inversions(inversion(t, 'core-1'), { health: { adviceThroughNext: false } }).length, 1);
  assert.equal(inversions(inversion(t, 'core-1'), undefined).length, 1);
});
