/** The live merged writer publishes a strict item in the same transaction when its group's full suite is green, under landing.strictFullSuite [M2,#9327]. */
/** @pullboard-test-input packages/store/src/io/board/merged.js packages/store/src/io/board/merged-table.js packages/store/src/logic/board/landing/lease.js */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../../../../gate/tests/fixtures/testkit.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const COMMIT = 'c'.repeat(40);
const TIP = 'a'.repeat(40);
const DIGEST = 'd'.repeat(64);
const SUITE = { kind: 'suite', suite: 'full', group: 'core', green: true, trusted: true, leased: true, commit: TIP, digest: DIGEST, base: 'b'.repeat(40) };

/** A board with item 7 verified in lane core under `pace`, on a private machine home with landing.strictFullSuite as given; `suite` is recorded as the group's newest receipt when given. */
function boardWith(t, { pace, setting, suite }) {
  const home = join(cellProject(t, { real: true }).dir, 'machine-home');
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  fixtureMachineSettings(home, setting === undefined ? {} : { landing: { strictFullSuite: setting } });
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'strict', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(TIP, DIGEST, TIP, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(TIP, JSON.stringify(pace === 'steady' ? {} : { pace }), DIGEST);
  board.db.exec('DELETE FROM temp.moving');
  if (suite) store.logEvent(board, 'coordinator', 'proof-run', null, { receipt: suite });
  return board;
}

/** The merge and publish events written for item 7, in order, and its merged commit. */
const landing = board => ({
  kinds: board.db.prepare("SELECT event_kind kind FROM event WHERE item_id=7 AND event_kind IN ('merged','published') ORDER BY event_id").all().map(row => row.kind),
  mergedCommit: board.db.prepare('SELECT item_merged_commit c FROM item WHERE item_id=7').get().c,
});
const merge = board => store.merged(board, 7, { agentId: 'coordinator', commit: COMMIT });

test('board.strict-publish.with-landing-strictfullsuite-strict-verified-item: clause 1: with landing.strictFullSuite on, a strict verified item with a green full-suite receipt merges and publishes in one transaction [M2,#9327]', t => {
  const board = boardWith(t, { pace: 'strict', setting: true, suite: SUITE });
  assert.deepEqual(landing(board), { kinds: [], mergedCommit: null });
  merge(board);
  assert.deepEqual(landing(board), { kinds: ['merged', 'published'], mergedCommit: COMMIT });
  const published = board.db.prepare("SELECT event_detail d FROM event WHERE item_id=7 AND event_kind='published'").get();
  assert.deepEqual(JSON.parse(published.d).commit, COMMIT);
});

test('board.strict-publish.without-the-full-suite-receipt-the: clause 2: without the full-suite receipt the strict merge is refused LAND_SUITE_PENDING and writes nothing [M2,#9327]', t => {
  for (const suite of [undefined, { ...SUITE, green: false }, { ...SUITE, group: 'web' }, { ...SUITE, suite: 'partial' }]) {
    const board = boardWith(t, { pace: 'strict', setting: true, suite });
    assert.throws(() => merge(board), error => error.code === 'LAND_SUITE_PENDING' && /full-suite receipt/u.test(error.message));
    assert.deepEqual(landing(board), { kinds: [], mergedCommit: null });
  }
});

test('board.strict-publish.with-the-setting-off-for-steady: clause 3: with the setting off, or for a steady item, the merge writes the one merged event as today [M2,#9327]', t => {
  for (const options of [{ pace: 'strict', setting: false, suite: SUITE }, { pace: 'strict', setting: undefined }, { pace: 'steady', setting: true, suite: SUITE }, { pace: 'steady', setting: true }]) {
    const board = boardWith(t, options);
    merge(board);
    assert.deepEqual(landing(board), { kinds: ['merged'], mergedCommit: COMMIT }, JSON.stringify(options));
  }
});
