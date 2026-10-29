/** Pending cipher pages finish each SQLite read before awaiting a remote ACK [H15,H17]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRelayPageCache, snapshotSourceId } from '../src/relay-page-cache.js';

/** Prepare a small child-first graph using only native positive rowid inserts. */
function graph(cache, label = 'pending') {
  const source = snapshotSourceId(label), values = [];
  for (let index = 0; index < 4; index++) {
    const bytes = Buffer.from(label + index);
    const value = { id: snapshotSourceId(bytes), sequence: 7, bytes, children: values.map(child => child.id) };
    cache.put(value); values.push(value);
  }
  cache.prepare(source, { id: values.at(-1).id, sequence: 7, bytes: 123 });
  return { source, values };
}

/** Open two real WAL connections in a fresh private device home, never an existing cache. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-pending-cache-'));
  const old = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = join(root, 'device');
  const state = { board: 'a'.repeat(32), url: 'https://synthetic-relay.example' };
  const cache = createRelayPageCache(state), seeded = graph(cache), writer = createRelayPageCache(state);
  t.after(() => {
    writer.close(); cache.close();
    if (old === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = old;
    rmSync(root, { recursive: true, force: true });
  });
  return { state, cache, writer, ...seeded };
}

/** Commit after crossing the same asynchronous boundary as the client's object PUT. */
async function competingCommit(writer) {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writer.firstNotice(snapshotSourceId('competing-writer')), true);
}

test('pending ACK after an awaited PUT tolerates a concurrent WAL commit [H15,H17]', async t => {
  const box = fixture(t), iterator = box.cache.pending(box.source);
  try {
    const first = iterator.next().value;
    await competingCommit(box.writer);
    box.cache.acknowledge(first.id);
    assert.equal(box.cache.object(first.id).acknowledged, true);
  } finally { iterator.return(); }
});

test('pending causal control: no competing writer before ACK [H15,H17]', async t => {
  const box = fixture(t), iterator = box.cache.pending(box.source);
  try {
    const first = iterator.next().value;
    await Promise.resolve(); box.cache.acknowledge(first.id);
    assert.equal(box.cache.object(first.id).acknowledged, true);
  } finally { iterator.return(); }
});

test('pending causal control: finalize the read before competing commit and ACK [H15,H17]', async t => {
  const box = fixture(t), iterator = box.cache.pending(box.source);
  const first = iterator.next().value; iterator.return();
  await competingCommit(box.writer); box.cache.acknowledge(first.id);
  assert.equal(box.cache.object(first.id).acknowledged, true);
});

test('pending causal control: competing commit precedes the first read [H15,H17]', async t => {
  const box = fixture(t); await competingCommit(box.writer);
  for (const value of box.cache.pending(box.source)) box.cache.acknowledge(value.id);
  assert.deepEqual([...box.cache.pending(box.source)], []);
});

test('pending stays lazy, source-bound and ordered while prior ACKs survive reopen [H15,H17]', t => {
  const box = fixture(t), other = graph(box.cache, 'other'), raw = new DatabaseSync(box.cache.file);
  try {
    raw.prepare('UPDATE object SET payload=? WHERE id=?').run(Buffer.from('damaged'), box.values[3].id);
    const iterator = box.cache.pending(box.source);
    try {
      const first = iterator.next().value;
      assert.equal(first.id, box.values[0].id, 'a later damaged page is not loaded eagerly');
      box.cache.acknowledge(first.id);
      assert.equal(iterator.next().value.id, box.values[1].id);
      assert.equal(iterator.next().value.id, box.values[2].id);
      assert.throws(() => iterator.next(), { code: 'RELAY_PAGE_CACHE' });
    } finally { iterator.return(); }
    const cold = createRelayPageCache(box.state);
    try {
      assert.equal(cold.object(box.values[0].id).acknowledged, true);
      assert.deepEqual([...cold.pending(other.source)].map(value => value.id), other.values.map(value => value.id));
    } finally { cold.close(); }
  } finally { raw.close(); }
});

test('pending observes another uploader ACK between yields [H15,H17]', t => {
  const box = fixture(t), iterator = box.cache.pending(box.source);
  try {
    const first = iterator.next().value;
    box.writer.acknowledge(box.values[1].id); box.cache.acknowledge(first.id);
    assert.deepEqual([...iterator].map(value => value.id), box.values.slice(2).map(value => value.id));
  } finally { iterator.return(); }
});

test('pending rowid cursor keeps integer precision beyond the Number safe range [H15,H17]', t => {
  const box = fixture(t), raw = new DatabaseSync(box.cache.file);
  try {
    for (const [index, value] of box.values.entries()) raw.prepare('UPDATE object SET rowid=? WHERE id=?').run(9007199254741000n + BigInt(index), value.id);
    assert.deepEqual([...box.cache.pending(box.source)].map(value => value.id), box.values.map(value => value.id));
  } finally { raw.close(); }
});

test('pending seeks by rowid without sorting the whole job for each page [H15,H17]', t => {
  const box = fixture(t), raw = new DatabaseSync(box.cache.file);
  try {
    const sql = /db\.prepare\('([^']+)'\)/u.exec(box.cache.pending.toString())[1];
    const plan = raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(box.source, 0);
    assert.ok(plan.some(row => /INTEGER PRIMARY KEY \(rowid>\?\)/u.test(row.detail)));
    assert.ok(plan.every(row => !/TEMP B-TREE/u.test(row.detail)));
    t.diagnostic(JSON.stringify({ pendingQueryPlan: plan }));
  } finally { raw.close(); }
});
