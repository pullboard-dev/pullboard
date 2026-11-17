/** The store's pulled writer runs the landing-pulled table: one pulled event ends a pull-out, and the table's refusals reach the caller [M2,R3,#9098]. */
/** @pullboard-test-input packages/store/src/io/board/pulled.js packages/store/src/logic/board/landing/lease.js packages/moves/src/logic/table/pulled.table.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const MERGED = 'c'.repeat(40);
const REVERT = 'e'.repeat(40);

/** A board with item #7 landed at MERGED and, when `pulling`, a pull_out event that reopened it for its builder. */
function landedItem(t, { pulling }) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare("UPDATE item SET item_commit=?, item_merged_commit=?, item_built_by='core-1' WHERE item_id=7").run('a'.repeat(40), MERGED);
  board.db.exec('DELETE FROM temp.moving');
  store.logEvent(board, 'coordinator', 'merged', 7, { commit: MERGED });
  if (pulling) store.logEvent(board, 'coordinator', 'pull_out', 7, { commit: 'a'.repeat(40), mergedCommit: MERGED, builder: 'core-1' });
  return board;
}

/** landingOf's reading, from moves rules.js: the newest pull_out, pulled or published event sets the landing; else the merged commit does. */
const LANDING_EVENTS = { pull_out: 'pulling', pulled: 'none', published: 'published' };

/** The item's landing events, oldest first, and its landing as landingOf derives it. */
function landing(board) {
  const row = board.db.prepare('SELECT item_merged_commit FROM item WHERE item_id=7').get();
  const history = board.db.prepare("SELECT event_kind kind, event_by by, event_detail d FROM event WHERE item_id=7 AND event_kind IN ('merged','pull_out','pulled','published') ORDER BY event_id").all()
    .map(event => ({ kind: event.kind, by: event.by, detail: JSON.parse(event.d) }));
  const last = history.findLast(event => Object.hasOwn(LANDING_EVENTS, event.kind));
  return { history, value: last ? LANDING_EVENTS[last.kind] : row.item_merged_commit ? 'landed' : 'none' };
}

test('board.pulled.coordinator-move-with-full-revert-sha: clause 1: a coordinator move with a full revert sha on a pulling item runs PULLED_TABLE and writes one pulled event, leaving landingOf none [M2,R3,#9098]', t => {
  const board = landedItem(t, { pulling: true });
  assert.equal(landing(board).value, 'pulling');
  const before = landing(board).history.length;
  const event = store.recordPulled(board, 7, { agentId: 'coordinator', revert: REVERT });
  assert.equal(event.event_kind, 'pulled');
  const after = landing(board);
  assert.equal(after.history.length, before + 1, 'one event is written');
  assert.deepEqual(after.history.at(-1), { kind: 'pulled', by: 'coordinator', detail: { commit: REVERT, reverted: MERGED } }, 'the event is the one PULLED_TABLE decides');
  assert.equal(after.value, 'none', 'the landing is back to none');
});

test('board.pulled.the-table-refusals-not-pulling-and: clause 2: the table refusals NOT_PULLING and REVERT_COMMIT surface unchanged from the writer, and write nothing [M2,R3,#9098]', t => {
  const landed = landedItem(t, { pulling: false });
  const written = landing(landed).history.length;
  assert.throws(() => store.recordPulled(landed, 7, { agentId: 'coordinator', revert: REVERT }), error => {
    assert.equal(error.code, 'NOT_PULLING');
    assert.equal(error.message, '[NOT_PULLING] item #7 has no pull-out in progress');
    assert.equal(error.next, 'pullboard show <id>');
    return true;
  });
  assert.equal(landing(landed).history.length, written);
  const pulling = landedItem(t, { pulling: true });
  for (const revert of [undefined, 'e'.repeat(12), 'not a sha']) {
    assert.throws(() => store.recordPulled(pulling, 7, { agentId: 'coordinator', revert }), error => {
      assert.equal(error.code, 'REVERT_COMMIT');
      assert.equal(error.message, '[REVERT_COMMIT] a pulled record names the full revert commit on main');
      assert.equal(error.next, 'pass the revert commit the lander pushed');
      return true;
    });
  }
  assert.equal(landing(pulling).value, 'pulling', 'a refused record leaves the item pulling');
  assert.throws(() => store.recordPulled(pulling, 7, { agentId: 'core-1', revert: REVERT }), { code: 'COORDINATOR_ONLY' });
  assert.throws(() => store.recordPulled(pulling, 99, { agentId: 'coordinator', revert: REVERT }), { code: 'NO_ITEM' });
});
