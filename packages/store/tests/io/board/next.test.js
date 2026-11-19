/** next reads only unfinished and in-flight items, never the board's landed and withdrawn history [C7, #10795]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../index.js';
import { listItems } from '../../../index.js';
import { nextFor } from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

/** A board mixing landed, withdrawn, claimed, lapsed, verified-unmerged and open items, each naming one file. */
function mixedBoard(t) {
  const board = fixtureBoard(t);
  const make = (title, file, lane = 'web', after = []) => addItem(board, { by: 'coordinator', lane, title, after, brief: `Files:\n- ${file}` });
  /** Place a status directly, the way the stage tests do: the fixture records where items stand, not how they got there. */
  const set = (id, fields) => {
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare(`UPDATE item SET ${Object.keys(fields).map(key => `${key}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(fields), id); }
    finally { board.db.exec('DELETE FROM temp.moving'); }
  };
  const ids = {
    landed: make('landed', 'src/a.js'),
    withdrawn: make('withdrawn', 'src/b.js'),
    claimed: make('claimed', 'src/c.js'),
    unmerged: make('verified unmerged', 'src/d.js'),
    lapsed: make('lapsed claim', 'src/e.js', 'api'),
    onClaimed: make('open on the claimed file', 'src/c.js'),
    onUnmerged: make('open on the unmerged file', 'src/d.js'),
    onLanded: make('open on the landed file', 'src/a.js'),
    onWithdrawn: make('open on the withdrawn file', 'src/b.js'),
  };
  ids.afterLanded = make('open after the landed item', 'src/h.js', 'web', [ids.landed]);
  ids.afterOpen = make('open after an open item', 'src/i.js', 'web', [ids.onClaimed]);
  const built = { item_built_by: 'web-1', item_commit: 'b'.repeat(40), item_frozen_digest: 'd'.repeat(64) };
  // The board's verified rule needs an ACCEPT on the frozen criterion by a verifier other than the builder, at the item's commit.
  for (const id of [ids.landed, ids.unmerged]) {
    board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      VALUES (?, 'web-3', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, '2026-11-18T00:00:00Z')`).run(id, built.item_commit, built.item_frozen_digest, built.item_commit);
  }
  set(ids.landed, { ...built, item_status: 'verified', item_verified_by: 'web-3', item_merged_commit: 'a'.repeat(40) });
  set(ids.withdrawn, { item_status: 'withdrawn', item_withdrawn_reason: 'not needed' });
  set(ids.claimed, { item_status: 'claimed', item_owner: 'web-1', item_lease_until: FUTURE, item_frozen_digest: 'd'.repeat(64) });
  set(ids.unmerged, { ...built, item_status: 'verified', item_verified_by: 'web-3', item_merged_commit: null });
  set(ids.lapsed, { item_status: 'claimed', item_owner: 'api-1', item_lease_until: PAST, item_frozen_digest: 'd'.repeat(64) });
  return { board, ids };
}

/** Every item-list statement nextFor prepares, read from the connection itself. */
function listedStatements(board) {
  const prepare = board.db.prepare.bind(board.db), seen = [];
  board.db.prepare = sql => { if (sql.includes('AS imported_rehome')) seen.push(sql); return prepare(sql); };
  return seen;
}

/** Any write moves the board's data version, so no remembered list answers the next read. */
function forget(board) {
  board.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES ('pg1-touch', ?)").run(String(Math.random()));
}

test('store.io-board-next.reads-only-unfinished-and-in-flight: clause 1: nextFor builds its candidate and in-flight lists from bounded reads and never lists every item of a board with landed and withdrawn items [C7, #10795]', t => {
  const { board, ids } = mixedBoard(t);
  forget(board);
  const seen = listedStatements(board);
  const picked = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(picked.item?.item_id, ids.onLanded, picked.reasons.join(' | '));
  assert.ok(seen.length > 0, 'nextFor read its lists through the item-list statement');
  for (const sql of seen) assert.match(sql, /AND (item_status NOT IN|\(item_status IN)/u, `every item list nextFor reads is bounded by status: ${sql}`);
  assert.ok(seen.some(sql => sql.includes("item_status IN ('claimed','submitted')")), 'the in-flight list is its own bounded read');
  const inFlight = listItems(board, { inFlight: true }).map(item => item.item_id);
  assert.deepEqual(inFlight, [ids.unmerged, ids.claimed], 'only claimed, submitted and unmerged verified items are in flight; a lapsed claim reads as open');
});

test('store.io-board-next.selection-matches-reading-every-item: clause 2: on a board mixing open, claimed, landed and withdrawn items, nextFor selects and explains exactly as it does from the all-items list [C7, #10795]', t => {
  const { board, ids } = mixedBoard(t);
  const pick = options => { forget(board); return nextFor(board, { agentId: 'web-2', lane: 'web', ...options }); };
  /** The same pick read from a remembered all-items list, the way every pick read before #10795. */
  const fromAll = options => { forget(board); listItems(board, { all: true }); return nextFor(board, { agentId: 'web-2', lane: 'web', ...options }); };
  const first = pick({});
  assert.equal(first.item?.item_id, ids.onLanded, 'a landed item never blocks an open one on its file');
  assert.ok(first.reasons.includes(`#${ids.onClaimed} waits for #${ids.claimed} (claimed) on src/c.js`), first.reasons.join(' | '));
  assert.ok(first.reasons.includes(`#${ids.onUnmerged} waits for #${ids.unmerged} (verified) on src/d.js`), first.reasons.join(' | '));
  const second = pick({ omitIds: [ids.onLanded] });
  assert.equal(second.item?.item_id, ids.onWithdrawn, 'a withdrawn item never blocks an open one on its file');
  const third = pick({ omitIds: [ids.onLanded, ids.onWithdrawn] });
  assert.equal(third.item?.item_id, ids.afterLanded, 'an item waiting only on a landed item is ready');
  const idle = pick({ omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded, ids.onClaimed, ids.onUnmerged] });
  assert.equal(idle.item, null, idle.reasons.join(' | '));
  assert.ok(idle.reasons.some(line => line.startsWith(`#${ids.afterOpen} waits on #${ids.onClaimed} (open`)), idle.reasons.join(' | '));
  for (const options of [{}, { omitIds: [ids.onLanded] }, { omitIds: [ids.onLanded, ids.onWithdrawn] }, { omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded] }, { lanes: ['web', 'api'] }, { observeIdle: true, idleBlockers: true, omitIds: [ids.onLanded, ids.onWithdrawn, ids.afterLanded, ids.onClaimed, ids.onUnmerged] }]) {
    assert.deepEqual(pick(options), fromAll(options), JSON.stringify(options));
  }
});
