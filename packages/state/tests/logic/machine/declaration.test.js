/** The verified proof admits a builder's self-accept only when a solo-low-stakes-accept event binds it [#966,C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { storeTriggers } from '../../../src/io/machine.js';

const COMMIT = 'c'.repeat(40);
const TREE = 't'.repeat(40);
const DIGEST = 'd'.repeat(64);

/** An in-memory board with only the tables the proof reads, the machine's triggers installed, and one submitted item. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_status TEXT, item_owner TEXT, item_lease_until TEXT, item_frozen_digest TEXT, item_built_by TEXT, item_commit TEXT, item_tree TEXT, item_verified_by TEXT, item_withdrawn_reason TEXT);
    CREATE TABLE verdict (verdict_id TEXT PRIMARY KEY, item_id INTEGER, verdict_decision TEXT, verdict_digest TEXT, verdict_by TEXT, verdict_commit TEXT);
    CREATE TABLE event (event_id INTEGER PRIMARY KEY, item_id INTEGER, event_kind TEXT, event_detail TEXT);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)`);
  for (const trigger of storeTriggers()) db.exec(trigger.sql);
  db.exec(`INSERT INTO item (item_id, item_status) VALUES (1, 'open')`);
  db.exec(`UPDATE item SET item_status = 'claimed', item_owner = 'builder', item_lease_until = 'later', item_frozen_digest = '${DIGEST}' WHERE item_id = 1`);
  db.exec(`UPDATE item SET item_status = 'submitted', item_built_by = 'builder', item_commit = '${COMMIT}', item_tree = '${TREE}' WHERE item_id = 1`);
  return db;
}

/** A builder's own ACCEPT verdict at the submitted commit. */
function selfVerdict(db) {
  db.prepare(`INSERT INTO verdict VALUES ('v1', 1, 'ACCEPT', ?, 'builder', ?)`).run(DIGEST, COMMIT);
}

/** A solo-low-stakes-accept event whose detail names the verdict, commit, tree, digest and by, with overrides. */
function soloEvent(db, over = {}) {
  const detail = { verdict: 'v1', commit: COMMIT, tree: TREE, digest: DIGEST, by: 'builder', ...over };
  db.prepare(`INSERT INTO event (item_id, event_kind, event_detail) VALUES (1, 'solo-low-stakes-accept', ?)`).run(JSON.stringify(detail));
}

const verify = db => db.exec(`UPDATE item SET item_status = 'verified', item_verified_by = 'builder' WHERE item_id = 1`);

test('state.machine-declaration.solo-low-stakes-bound: clause 1: a move to verified with verdict_by equal to item_built_by passes only with a solo-low-stakes-accept event naming the same verdict, commit, tree, digest and by [#966,C7]', () => {
  const db = board();
  selfVerdict(db);
  soloEvent(db);
  verify(db);
  assert.equal(db.prepare('SELECT item_status FROM item WHERE item_id = 1').get().item_status, 'verified');
});

test('state.machine-declaration.self-accept-refused-unbound: clause 2: the same self-accept is refused NOT_PROVEN with no event or an event naming another commit or digest, and independent and merge-only accepts still pass [#966,C7]', () => {
  const refused = (prepare) => {
    const db = board();
    selfVerdict(db);
    prepare(db);
    assert.throws(() => verify(db), /NOT_PROVEN/u);
  };
  refused(() => {});
  refused(db => soloEvent(db, { commit: 'e'.repeat(40) }));
  refused(db => soloEvent(db, { digest: 'f'.repeat(64) }));
  refused(db => soloEvent(db, { verdict: 'other' }));
  refused(db => soloEvent(db, { by: 'someone' }));

  const independent = board();
  independent.prepare(`INSERT INTO verdict VALUES ('v2', 1, 'ACCEPT', ?, 'reviewer', ?)`).run(DIGEST, COMMIT);
  independent.exec(`UPDATE item SET item_status = 'verified', item_verified_by = 'reviewer' WHERE item_id = 1`);
  assert.equal(independent.prepare('SELECT item_status FROM item WHERE item_id = 1').get().item_status, 'verified');

  const mergeOnly = board();
  mergeOnly.prepare(`INSERT INTO verdict VALUES ('v3', 1, 'ACCEPT', ?, 'reviewer', 'older')`).run(DIGEST);
  mergeOnly.prepare(`INSERT INTO event (item_id, event_kind, event_detail) VALUES (1, 'merge-only-accept', ?)`).run(JSON.stringify({ verdict: 'v3', commit: COMMIT, tree: TREE, digest: DIGEST, by: 'reviewer' }));
  mergeOnly.exec(`UPDATE item SET item_status = 'verified', item_verified_by = 'reviewer' WHERE item_id = 1`);
  assert.equal(mergeOnly.prepare('SELECT item_status FROM item WHERE item_id = 1').get().item_status, 'verified');
});
