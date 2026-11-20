/** A claimed item's sharded gate that settled unknown (main receipt missing) stays unsettled until a later settle replaces it; red and review are settled [#11711,C7]. The hold counts from the shard offer, not the gate's creation [#11921]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/dispatch.js';
import { GATE_SETTLE_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { handoffRecords } from '../../../../src/io/submit/handoff/records.js';
import { gateShardsUnsettled } from '../../../../src/io/submit/handoff/records.js';
import { awaitingGateOrReview } from '../../../../src/io/submit/handoff/records.js';
import { getItem } from '../../../../index.js';

/** A claimed item whose gate job, submitted by its holder, is done, with two shard jobs done; `settle(outcome)` notes the combined result. */
function settledGate(t) {
  const box = fixture(t);
  const id = box.add('Item whose gate settled');
  box.claim(id);
  const at = box.clock.now().getTime();
  const gate = `gate:${id}:0123456789ab:fixture`;
  const job = (jobId, kind) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, 'done', NULL, 0, ?, ?)`).run(jobId, kind, id, at, at);
  job(gate, 'gate');
  job(`${gate}:shard:1`, 'gate-shard');
  job(`${gate}:shard:2`, 'gate-shard');
  const owner = getItem(box.board, id).item_owner;
  box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'offered', ?, ?)")
    .run(gate, JSON.stringify({ request: { submit: { agentId: owner } } }), at);
  const settle = outcome => box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
    .run(gate, JSON.stringify({ outcome }), at);
  return { box, item: { item_id: id, item_owner: owner }, settle };
}

test('store.submit-handoff-records.unknown-gate-holds-claim: clause 1: an unknown settled gate younger than the hold is unsettled, a red or review one is settled [C7,#11711]', t => {
  const unknown = settledGate(t);
  unknown.settle('unknown');
  assert.equal(gateShardsUnsettled(unknown.box.board, unknown.item), true);
  for (const outcome of ['red', 'review']) {
    const other = settledGate(t);
    other.settle(outcome);
    assert.equal(gateShardsUnsettled(other.box.board, other.item), false, `${outcome} is settled`);
  }
});

test('store.submit-handoff-records.unknown-on-main-receipt-awaits: clause 1: a claimed item whose gate is unknown on a missing main receipt is awaiting, however long ago it offered [C7,#11924]', t => {
  const f = settledGate(t);
  f.settle('unknown');
  f.box.advance(GATE_SETTLE_HOLD_MS + 1);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), true, 'past the fallback bound, an unknown gate still holds');
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.item.item_id)), true, 'so next does not hand its lapsed claim to a fresh seat');
});

test('store.submit-handoff-records.unknown-settles-red: clause 2: once the receipt records and the gate settles red, the item is no longer awaiting [C7,#11924]', t => {
  const f = settledGate(t);
  f.settle('unknown');
  f.box.advance(GATE_SETTLE_HOLD_MS + 1);
  f.box.board.db.prepare("UPDATE job_step SET job_step_payload = ? WHERE job_step_name = 'note:shards.settled'").run(JSON.stringify({ outcome: 'red' }));
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false);
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.item.item_id)), false, 'a settled red returns the claim as rework');
});

/** A claimed item whose gate job was created 3 h ago, queued, and passed its checks 1 h ago, offering two shards that are still open. */
function lateGate(t) {
  const box = fixture(t);
  const id = box.add('Item whose gate queued before its checks');
  box.claim(id);
  const now = box.clock.now().getTime();
  const created = now - 3 * 3_600_000;
  const offered = now - 3_600_000;
  const gate = `gate:${id}:0123456789ab:late`;
  const job = (jobId, kind, step, at, updated) => box.board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`).run(jobId, kind, id, step, at, updated);
  job(gate, 'gate', 'done', created, offered);
  job(`${gate}:shard:1`, 'gate-shard', 'offered', offered, offered);
  job(`${gate}:shard:2`, 'gate-shard', 'claimed', offered, offered);
  /** The last shard posts, then the board notes the combined result, as it does when a sharded gate settles. */
  const settle = outcome => {
    box.board.db.prepare("UPDATE job SET job_step = 'done' WHERE job_kind = 'gate-shard' AND job_item = ?").run(id);
    box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
      .run(gate, JSON.stringify({ outcome }), box.clock.now().getTime());
  };
  return { box, item: { item_id: id }, id, settle };
}

test('store.submit-handoff-records.hold-counts-from-shard-offer: clause 1: a gate created 3 h ago that offered its open shards 1 h ago is unsettled and awaiting its gate [C7,#11921]', t => {
  const f = lateGate(t);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), true, 'the hold counts from the shard offer, not the gate creation 3 h ago');
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.id)), true, 'so the claim is the gate\'s wait, not buildable work');
});

test('store.submit-handoff-records.open-shard-holds: clause 1: a gate offered 3 h ago with one shard still offered is unsettled [C7,#11923]', t => {
  const f = lateGate(t);
  f.box.advance(2 * 3_600_000);
  const db = f.box.board.db;
  db.prepare("UPDATE job SET job_step = 'done' WHERE job_kind = 'gate-shard' AND job_item = ? AND job_step = 'claimed'").run(f.id);
  assert.equal(db.prepare("SELECT job_step FROM job WHERE job_kind = 'gate-shard' AND job_item = ? AND job_step = 'offered'").all(f.id).length, 1, 'one shard is still offered');
  assert.equal(gateShardsUnsettled(f.box.board, f.item), true, 'offered 3 h ago, past the 2 h fallback, an offered shard still holds');
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.id)), true);
});

test('store.submit-handoff-records.no-open-shard-settles: clause 2: a gate offered 3 h ago with no open shard job is settled [C7,#11923]', t => {
  const f = lateGate(t);
  f.box.advance(2 * 3_600_000);
  f.box.board.db.prepare("UPDATE job SET job_step = 'done' WHERE job_kind = 'gate-shard' AND job_item = ?").run(f.id);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false, 'all shards done and 3 h past the offer: the fallback bound ends the hold');
  const bare = settledGate(t);
  bare.box.advance(3 * 3_600_000);
  bare.box.board.db.prepare("DELETE FROM job WHERE job_kind = 'gate-shard'").run();
  assert.equal(gateShardsUnsettled(bare.box.board, bare.item), false, 'a gate whose shards are gone is settled');
});

test('store.submit-handoff-records.late-gate-red-settles: clause 2: that late gate, once it notes shards.settled red, is settled and no longer holds the claim [C7,#11921]', t => {
  const f = lateGate(t);
  f.settle('red');
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false);
  assert.equal(awaitingGateOrReview(f.box.board, getItem(f.box.board, f.id)), false, 'a settled red returns the claim as rework');
});

/** The query handoffRecords ran before #11920, payloads inside the ORDER BY, kept as the reference for what it must return. */
function referenceRecords(db, live) {
  const records = new Map();
  const rows = db.prepare(`SELECT j.job_item AS item, s.job_step_payload AS payload FROM job j
    JOIN job_step s ON s.job_step_id = (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = j.job_id AND job_step_name NOT LIKE 'note:%')
    WHERE j.job_kind = 'gate' AND j.job_item IS NOT NULL${live ? " AND j.job_item IN (SELECT item_id FROM item WHERE item_status NOT IN ('verified', 'withdrawn'))" : ''}
    ORDER BY s.job_step_id DESC`).all();
  for (const row of rows) {
    if (records.has(row.item) || !row.payload.includes('"record"')) continue;
    records.set(row.item, JSON.parse(row.payload).record);
  }
  return records;
}

/** Items with two gate jobs each: the newer job's last step may lack a record, and a later note step never counts. */
function twoJobBoard(t) {
  const box = fixture(t);
  const db = box.board.db;
  const at = box.clock.now().getTime();
  const step = (job, name, payload) => db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)').run(job, name, JSON.stringify(payload), at);
  const ids = [];
  for (let n = 0; n < 4; n++) {
    const id = box.add(`Handoff item ${n}`);
    ids.push(id);
    for (const [order, jobId] of [`gate:${id}:aaaaaaaaaaaa:fixture`, `gate:${id}:bbbbbbbbbbbb:fixture`].entries()) {
      db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
        VALUES (?, 'gate', ?, 'done', NULL, 0, ?, ?)`).run(jobId, id, at + order, at + order);
      // Item 1's newer job has no record on any step, so its older job's record is the current one.
      if (!(n === 1 && order === 1)) step(jobId, 'finish', { record: { state: 'green', job: order, item: id } });
      else step(jobId, 'finish', { other: true });
      step(jobId, 'note:late', { record: { state: 'note', item: id } });
    }
  }
  return { box, ids };
}

test('store.handoff-records.newest-per-item-keys-sort: clause 1: handoffRecords with and without live returns the map the payload-sorting query returned [C7,#11920]', t => {
  const { box, ids } = twoJobBoard(t);
  for (const live of [false, true]) {
    const got = handoffRecords(box.board.db, { live });
    assert.deepEqual([...got], [...referenceRecords(box.board.db, live)], `live ${live}`);
  }
  assert.equal(handoffRecords(box.board.db).get(ids[1]).job, 0, 'the newer job without a record falls back to the older one');
  assert.equal(handoffRecords(box.board.db).get(ids[0]).job, 1);
  assert.equal(handoffRecords(box.board.db, { live: true }).size, ids.length, 'every open item is live');
});

test('store.handoff-records.no-payload-sort: clause 2: no statement handoffRecords prepares sorts in a temp B-tree [C7,#11920]', t => {
  const { box } = twoJobBoard(t);
  const sql = [];
  const spy = new Proxy(box.board.db, { get: (db, key) => key === 'prepare' ? text => (sql.push(text), db.prepare(text)) : db[key] });
  for (const live of [false, true]) handoffRecords(spy, { live });
  const reads = sql.filter(text => text.includes('job_step_payload'));
  assert.ok(reads.length > 0, 'the payload read is prepared');
  for (const text of sql) {
    const plan = box.board.db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...(text.includes('?') ? [1] : [])).map(row => row.detail).join('\n');
    assert.doesNotMatch(plan, /USE TEMP B-TREE/u, text);
  }
});

test('store.submit-handoff-records.pruned-step-skipped: clause 1: a listed step whose row is gone before the payload read is skipped and the other records return [C7,#11929]', t => {
  const { box, ids } = twoJobBoard(t);
  const db = box.board.db;
  const newest = db.prepare("SELECT MAX(s.job_step_id) AS id FROM job_step s JOIN job j ON j.job_id = s.job_step_job WHERE j.job_item = ? AND j.job_id LIKE '%bbbbbbbbbbbb%' AND s.job_step_name NOT LIKE 'note:%'").get(ids[0]).id;
  const wrapper = new Proxy(db, { get: (real, key) => key === 'prepare' ? text => {
    const statement = real.prepare(text);
    if (!text.includes('WHERE job_step_id = ?')) return statement;
    return { get: id => (real.prepare('DELETE FROM job_step WHERE job_step_id = ?').run(newest), statement.get(id)) };
  } : typeof real[key] === 'function' ? real[key].bind(real) : real[key] });
  const got = handoffRecords(wrapper);
  assert.equal(got.get(ids[0]).job, 0, 'the pruned step is skipped and the item\'s next-older step is used');
  assert.equal(got.get(ids[2]).job, 1, 'the other items keep their records');
  assert.equal(got.size, ids.length);
});
