/** Durable upload publication, pinned readers and quota refusal preserve opaque snapshot graphs [H15,H17,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRelayPages } from '../../../index.js';
import { createRelayJournal } from '../../../index.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { generateBoardKey } from '../../../../../packages/kernel/index.js';
import { PAGE_BYTES } from '../../../../../packages/pages/index.js';
import { readSealedValue } from '../../../../../packages/pages/index.js';
import { writeSealedValue } from '../../../../../packages/pages/index.js';

const machine = { kind: 'machine', userId: '1', machine: 'fixture-native' };
const agent = { kind: 'agent', userId: '1', agent: 'fixture-reader' };

/** Open only a synthetic private relay database with a controllable lease clock. */
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-sealed-pages-'));
  const boardId = 'a'.repeat(32);
  const key = await generateBoardKey();
  let time = 1_000;
  const options = { directory, boardId, now: () => time };
  const stores = [createRelayPages(options)];
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const box = {
    key, boardId, store: stores[0],
    /** Advance the product lease clock without an elapsed-time performance assertion. */
    advance(ms) { time += ms; },
    /** Share the fixture clock with a journal borrowing this store's connection. */
    now() { return time; },
    /** Reopen actual on-disk state after a simulated process restart. */
    reopen() { box.store.close(); box.store = createRelayPages(options); stores.push(box.store); },
    /** Upload actual encrypted objects without publishing a head prematurely. */
    async stage(value, sequence = 7, checkBudget) {
      const upload = box.store.begin(machine, sequence);
      const objects = [];
      const reference = await writeSealedValue(value, { key, boardId, sequence,
        put(object) { objects.push(object); box.store.put(upload.id, machine, object, checkBudget); } });
      return { upload, reference, objects };
    },
    /** Read only through the same principal's root pin and authenticated object path. */
    read(reference, pin, who = agent) {
      return readSealedValue(reference, { key, boardId,
        get(id, parents) { return box.store.get(pin.id, who, id, parents).bytes; } });
    },
  };
  return box;
}

test('an old pinned reader survives replacement and only expires after its last read [H15,H17,H18]', async t => {
  const box = await fixture(t);
  const first = await box.stage({ marker: 'first published snapshot' });
  let head;
  box.store.publish(first.upload.id, machine, first.reference, reference => { head = reference; });
  const pin = box.store.pin(agent, head);
  const next = await box.stage({ marker: 'new published snapshot' }, 8);
  box.store.publish(next.upload.id, machine, next.reference, reference => { head = reference; });
  box.store.prune([head.id]);
  assert.equal((await box.read(first.reference, pin)).marker, 'first published snapshot');
  box.advance(899_999);
  assert.equal((await box.read(first.reference, pin)).marker, 'first published snapshot', 'an active reader renews its own lease');
  box.advance(899_999);
  assert.equal((await box.read(first.reference, pin)).marker, 'first published snapshot');
  box.advance(900_001);
  box.store.prune([head.id]);
  await assert.rejects(box.read(first.reference, pin), { code: 'SNAPSHOT_READ_EXPIRED' });
  const current = box.store.pin(agent, head);
  assert.equal((await box.read(head, current)).marker, 'new published snapshot');
  assert.equal(box.store.usage().objects, next.objects.length, 'only unreferenced expired data was collected');
});

test('quota refusal cannot change a previous head or partially store the refused object [H15,H17]', async t => {
  const box = await fixture(t);
  const first = await box.stage({ marker: 'previous readable head' });
  let head;
  box.store.publish(first.upload.id, machine, first.reference, reference => { head = reference; });
  const pin = box.store.pin(agent, head);
  const before = box.store.usage().bytes;
  await assert.rejects(box.stage({ marker: 'refused replacement' }, 8, () => {
    throw new Refused('ACCOUNT_STORAGE_LIMIT', 'Synthetic account storage limit reached.');
  }), { code: 'ACCOUNT_STORAGE_LIMIT' });
  assert.equal(box.store.usage().bytes, before);
  assert.equal((await box.read(head, pin)).marker, 'previous readable head');
});

test('retrying the exact object is free while changed metadata cannot reuse its identity [H15,H17]', async t => {
  const box = await fixture(t);
  let charged = 0;
  const staged = await box.stage({ marker: 'idempotent object' }, 7, bytes => { charged += bytes; });
  const before = charged;
  for (const object of staged.objects) assert.equal(box.store.put(staged.upload.id, machine, object, bytes => { charged += bytes; }).stored, false);
  assert.equal(charged, before);
  assert.throws(() => box.store.put(staged.upload.id, machine, { ...staged.objects[0], sequence: 8 }), { code: 'SNAPSHOT_PAGE_CONFLICT' });
});

test('an agent may read a pinned head but cannot publish or borrow another principal’s session [H15,H17]', async t => {
  const box = await fixture(t);
  assert.throws(() => box.store.begin(agent, 7), { code: 'HUMAN_REQUIRED' });
  const staged = await box.stage({ marker: 'authorized head' });
  box.store.publish(staged.upload.id, machine, staged.reference, () => {});
  const pin = box.store.pin(agent, staged.reference);
  assert.equal((await box.read(staged.reference, pin)).marker, 'authorized head');
  await assert.rejects(box.read(staged.reference, pin, { ...agent, userId: '2' }), { code: 'SNAPSHOT_READ_EXPIRED' });
  const other = box.store.begin(machine, 8);
  assert.throws(() => box.store.put(other.id, { ...machine, machine: 'another-native' }, staged.objects[0]), { code: 'SNAPSHOT_UPLOAD_EXPIRED' });
});

test('knowing a staged object id does not make it readable through another pinned head [H15,H17]', async t => {
  const box = await fixture(t);
  const first = await box.stage({ marker: 'current root', text: 'x'.repeat(PAGE_BYTES * 2) });
  box.store.publish(first.upload.id, machine, first.reference, () => {});
  const pin = box.store.pin(agent, first.reference);
  const future = await box.stage({ marker: 'unpublished future data' }, 8);
  assert.throws(() => box.store.get(pin.id, agent, future.reference.id), { code: 'BAD_PAGE_PATH' });
  assert.throws(() => box.store.get(pin.id, agent, future.reference.id, [first.reference.id]), { code: 'BAD_PAGE_PATH' });
  assert.equal((await box.read(first.reference, pin)).marker, 'current root');
});

test('missing and cyclic opaque graphs cannot publish or make staging collection permanent [H15,H17,H18]', async t => {
  const box = await fixture(t);
  const upload = box.store.begin(machine, 7);
  const firstBytes = Uint8Array.of(1, 2, 3);
  const secondBytes = Uint8Array.of(4, 5, 6);
  const first = createHash('sha256').update(firstBytes).digest('hex');
  const second = createHash('sha256').update(secondBytes).digest('hex');
  box.store.put(upload.id, machine, { id: first, sequence: 7, bytes: firstBytes, children: [second] });
  let published = false;
  assert.throws(() => box.store.publish(upload.id, machine, { id: first, sequence: 7, bytes: 1 }, () => { published = true; }), { code: 'SNAPSHOT_PAGE_MISSING' });
  box.store.put(upload.id, machine, { id: second, sequence: 7, bytes: secondBytes, children: [first] });
  assert.throws(() => box.store.publish(upload.id, machine, { id: first, sequence: 7, bytes: 1 }, () => { published = true; }), { code: 'SNAPSHOT_GRAPH' });
  assert.equal(published, false);
  assert.doesNotThrow(() => box.store.prune([]), 'unfinished cyclic metadata does not block collection of other data');
  box.advance(3_600_001);
  box.store.prune([]);
  assert.equal(box.store.usage().objects, 0);
});

test('published objects and an existing reader pin survive closing the database [H15,H17]', async t => {
  const box = await fixture(t);
  const staged = await box.stage({ marker: 'durable encrypted graph' });
  box.store.publish(staged.upload.id, machine, staged.reference, () => {});
  const pin = box.store.pin(agent, staged.reference);
  box.reopen();
  assert.equal((await box.read(staged.reference, pin)).marker, 'durable encrypted graph');
});

test('one database transaction rolls back a head and upload cleanup together [H15,H17,H18]', async t => {
  const box = await fixture(t);
  const staged = await box.stage({ marker: 'atomic publication fixture' }, 0);
  const journal = createRelayJournal({ directory: dirname(box.store.file), boardId: box.boardId, now: () => new Date(box.now()) });
  const pages = journal.pages({ now: box.now });
  try {
    // The upload was staged through another connection; the journal and object tables are in the same file.
    assert.throws(() => pages.publish(staged.upload.id, machine, staged.reference, (reference, bytes) => {
      journal.saveSnapshot(reference.sequence, bytes, machine, { apiVersion: 2, pageBytes: reference.bytes });
      throw new Error('Synthetic failure after the head write.');
    }), /Synthetic failure after the head write/u);
    assert.equal(journal.snapshot(), null, 'no partial head escaped the failed transaction');
    const result = pages.publish(staged.upload.id, machine, staged.reference, (reference, bytes) =>
      journal.saveSnapshot(reference.sequence, bytes, machine, { apiVersion: 2, pageBytes: reference.bytes }));
    assert.equal(result.apiVersion, 2);
    assert.equal(journal.snapshot().sequence, 0);
  } finally { pages.close(); journal.close(); }
});


test('pin validates a multi-object graph with one prepared lookup [H5,H17]', async t => {
  const box = await fixture(t);
  const value = { marker: 'validated graph', text: 'g'.repeat(PAGE_BYTES * 3) };
  const staged = await box.stage(value);
  assert.ok(staged.objects.length > 1, 'the actual sealed graph contains multiple objects');
  box.store.publish(staged.upload.id, machine, staged.reference, () => {});
  const prepare = DatabaseSync.prototype.prepare;
  let lookups = 0;
  /** Count real statement compilation while retaining every native SQLite query and result. */
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql, ...args) {
    if (sql === 'SELECT id,children FROM page_object WHERE id=?') lookups++;
    return Reflect.apply(prepare, this, [sql, ...args]);
  });
  const pin = box.store.pin(agent, staged.reference);
  assert.equal(lookups, 1, 'the full graph traversal compiles its lookup once');
  assert.deepEqual(await box.read(staged.reference, pin), value);
});
