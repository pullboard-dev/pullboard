/** A claimed item's sharded gate that settled unknown (main receipt missing) stays unsettled until the hold ends; red and review are settled [#11711,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../fixtures/dispatch.js';
import { GATE_SETTLE_HOLD_MS } from '../../../../src/io/submit/handoff/records.js';
import { handoffRecords } from '../../../../src/io/submit/handoff/records.js';
import { gateShardsUnsettled } from '../../../../src/io/submit/handoff/records.js';

/** A claimed item whose gate job is done, with two shard jobs done; `settle(outcome)` notes the combined result. */
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
  const settle = outcome => box.board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'note:shards.settled', ?, ?)")
    .run(gate, JSON.stringify({ outcome }), at);
  return { box, item: { item_id: id }, settle };
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

test('store.submit-handoff-records.unknown-gate-hold-ends: clause 2: the same unknown gate older than the hold is settled [C7,#11711]', t => {
  const f = settledGate(t);
  f.settle('unknown');
  f.box.advance(GATE_SETTLE_HOLD_MS + 1);
  assert.equal(gateShardsUnsettled(f.box.board, f.item), false);
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
