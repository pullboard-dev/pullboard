/** Sealed pages encrypt JSON into bounded content-addressed objects and refuse anything tampered, mispositioned or over budget [H15,H17,H18]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PAGE_BYTES } from '../../index.js';
import { PAGE_CIPHER_BYTES } from '../../index.js';
import { PAGE_FANOUT } from '../../index.js';
import { pageDigest } from '../../index.js';
import { pageReference } from '../../index.js';
import { readSealedBytes } from '../../index.js';
import { readSealedDescriptor } from '../../index.js';
import { readSealedValue } from '../../index.js';
import { sealedPageFingerprint } from '../../index.js';
import { writeSealedDescriptor } from '../../index.js';
import { writeSealedValue } from '../../index.js';

const BOARD = 'a'.repeat(32);
const refused = code => error => error.code === code;

/** An in-memory object store and the write and read contexts over it, with a fresh random board key. */
function store(sequence = 7) {
  const objects = new Map();
  const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const gets = [];
  return {
    objects, gets, key,
    write: { key, boardId: BOARD, sequence, put: object => { objects.set(object.id, object); } },
    read: { key, boardId: BOARD, get: (id, parents) => { gets.push([id, parents]); return objects.get(id).bytes; } },
  };
}

test('pages.sealed.a-page-digest-is-the-sha: a page digest is the SHA-256 of exactly the bytes it is given, and a reference is validated before use [H15]', async () => {
  assert.equal(await pageDigest(new TextEncoder().encode('abc')), createHash('sha256').update('abc').digest('hex'));
  const id = 'f'.repeat(64);
  assert.deepEqual(pageReference({ id, sequence: 3, bytes: 10, extra: 'dropped' }), { id, sequence: 3, bytes: 10 });
  for (const bad of [null, {}, { id: 'F'.repeat(64), sequence: 0, bytes: 0 }, { id: 'f'.repeat(63), sequence: 0, bytes: 0 }, { id, sequence: -1, bytes: 0 }, { id, sequence: 0, bytes: 1.5 }, { id, sequence: 0, bytes: -1 }]) {
    assert.throws(() => pageReference(bad), refused('SNAPSHOT_PAGE_FORMAT'), JSON.stringify(bad));
  }
});

test('pages.sealed.a-small-value-seals-into-one: a small value seals into one encrypted object that reads back, and plaintext never appears in what is stored [H15,H17]', async () => {
  const box = store();
  const value = { marker: 'a recognisable plaintext marker', list: [1, 2, 3] };
  const reference = await writeSealedValue(value, box.write);
  assert.equal(box.objects.size, 1);
  assert.deepEqual([reference.sequence, reference.bytes], [7, JSON.stringify(value).length]);
  const stored = box.objects.get(reference.id);
  assert.equal(stored.id, await pageDigest(stored.bytes), 'content addressed');
  assert.deepEqual(stored.children, []);
  assert.equal(Buffer.from(stored.bytes).includes('recognisable'), false);
  assert.deepEqual(await readSealedValue(reference, box.read), value);
});

test('pages.sealed.a-value-past-one-page-splits: a value past one page splits into bounded leaves under an index and reads back in order [H15,H17]', async () => {
  const box = store();
  const value = { text: 'x'.repeat(PAGE_BYTES * 2 + 50) };
  const reference = await writeSealedValue(value, box.write);
  const objects = [...box.objects.values()];
  const leaves = Math.ceil(JSON.stringify(value).length / PAGE_BYTES);
  assert.ok(leaves > 1, 'the value needs more than one page');
  assert.equal(objects.length, leaves + 1, 'one object per leaf plus the index over them');
  assert.ok(objects.every(object => object.bytes.byteLength <= PAGE_CIPHER_BYTES));
  const index = box.objects.get(reference.id);
  assert.equal(index.children.length, leaves);
  assert.equal(reference.bytes, JSON.stringify(value).length, 'the root names the whole value\'s length');
  const chunks = [];
  for await (const chunk of readSealedBytes(reference, box.read)) chunks.push(chunk.byteLength);
  assert.deepEqual(chunks, [PAGE_BYTES, PAGE_BYTES, reference.bytes - 2 * PAGE_BYTES]);
  assert.deepEqual(await readSealedValue(reference, box.read), value);
  assert.deepEqual(box.gets[0][1], [], 'the root is requested with no parents');
  assert.deepEqual(box.gets[1][1], [reference.id], 'a child is requested under its parent');
});

test('pages.sealed.a-device-private-lookup-reuses-pages: a device-private lookup reuses pages already uploaded instead of putting them again [H15]', async () => {
  const box = store();
  const known = new Map();
  const context = { ...box.write, lookup: fingerprint => known.get(fingerprint), remember: (fingerprint, reference) => { known.set(fingerprint, reference); } };
  const first = await writeSealedValue({ same: 'content' }, context);
  const puts = box.objects.size;
  const second = await writeSealedValue({ same: 'content' }, context);
  assert.deepEqual(second, first);
  assert.equal(box.objects.size, puts, 'nothing new was uploaded');
});

test('pages.sealed.tampered-bytes-a-wrong-key-and: tampered bytes, a wrong key and a wrong position are refused before any content is returned [H15,H17]', async () => {
  const box = store();
  const reference = await writeSealedValue({ secret: 'value' }, box.write);
  const original = box.objects.get(reference.id);
  const flipped = Uint8Array.from(original.bytes);
  flipped[flipped.length - 1] ^= 1;
  box.objects.set(reference.id, { ...original, bytes: flipped });
  await assert.rejects(readSealedValue(reference, box.read), refused('SNAPSHOT_PAGE_FORMAT'), 'the bytes no longer match their address');
  box.objects.set(reference.id, original);
  const stranger = { ...box.read, key: globalThis.crypto.getRandomValues(new Uint8Array(32)) };
  await assert.rejects(readSealedValue(reference, stranger), refused('SEAL_AUTH_FAILED'));
  await assert.rejects(readSealedValue({ ...reference, sequence: reference.sequence + 1 }, box.read), refused('SEAL_AUTH_FAILED'));
  await assert.rejects(readSealedValue(reference, { ...box.read, boardId: 'b'.repeat(32) }), refused('SEAL_AUTH_FAILED'));
  await assert.rejects(readSealedValue(reference, { ...box.read, get: () => 'not bytes' }), refused('SNAPSHOT_PAGE_FORMAT'));
  await assert.rejects(readSealedValue({ ...reference, bytes: reference.bytes + 1 }, box.read), refused('SNAPSHOT_PAGE_FORMAT'), 'a lying length is refused');
  assert.deepEqual(await readSealedValue(reference, box.read), { secret: 'value' });
});

test('pages.sealed.a-reader-s-byte-budget-refuses: a reader\'s byte budget refuses a value larger than it will allocate, before fetching a page [H15]', async () => {
  const box = store();
  const reference = await writeSealedValue({ text: 'y'.repeat(1000) }, box.write);
  box.gets.length = 0;
  await assert.rejects(readSealedValue(reference, box.read, { maxBytes: 100 }), refused('SNAPSHOT_PAGE_FORMAT'));
  assert.equal(box.gets.length, 0);
  assert.deepEqual((await readSealedValue(reference, box.read, { maxBytes: 2000 })).text.length, 1000);
});

test('pages.sealed.a-value-that-cannot-be-written: a value that cannot be written as JSON, or a writer with nowhere to put pages, is refused [H15]', async () => {
  const box = store();
  const loop = {};
  loop.self = loop;
  await assert.rejects(writeSealedValue(loop, box.write), refused('SNAPSHOT_PAGE_FORMAT'));
  await assert.rejects(writeSealedValue(undefined, box.write), refused('SNAPSHOT_PAGE_FORMAT'));
  await assert.rejects(writeSealedValue({}, { ...box.write, put: undefined }), refused('SNAPSHOT_PAGE_FORMAT'));
});

test('pages.sealed.a-descriptor-seals-a-value-with: a descriptor seals a value with the references it reaches, and reading one touches none of them [H15,H18]', async () => {
  const box = store();
  const child = await writeSealedValue({ child: true }, box.write);
  const reference = await writeSealedDescriptor({ head: 'current' }, [child], box.write);
  assert.deepEqual(box.objects.get(reference.id).children, [child.id], 'the relay sees only opaque reachability edges');
  box.gets.length = 0;
  assert.deepEqual(await readSealedDescriptor(reference, box.read), { value: { head: 'current' }, links: [child] });
  assert.equal(box.gets.length, 1, 'the linked child was not fetched');
  await assert.rejects(readSealedDescriptor(child, box.read), refused('SNAPSHOT_PAGE_FORMAT'), 'a value page is not a descriptor');
  await assert.rejects(writeSealedDescriptor({}, Array.from({ length: PAGE_FANOUT + 1 }, () => child), box.write), refused('SNAPSHOT_PAGE_FORMAT'));
  await assert.rejects(writeSealedDescriptor({}, 'not links', box.write), refused('SNAPSHOT_PAGE_FORMAT'));
});

test('pages.sealed.the-private-fingerprint-of-a-page: the private fingerprint of a page is stable for equal content and differs for other content [H15]', async () => {
  const first = store();
  const second = store();
  const a = await writeSealedValue({ n: 1 }, first.write);
  const b = await writeSealedValue({ n: 1 }, second.write);
  const c = await writeSealedValue({ n: 2 }, first.write);
  const fingerprint = (reference, box) => sealedPageFingerprint(reference, box.read);
  assert.notEqual(a.id, b.id, 'every seal uses a fresh nonce');
  assert.equal(await fingerprint(a, first), await fingerprint(b, second), 'equal content shares a fingerprint, whatever the key or nonce');
  assert.notEqual(await fingerprint(a, first), await fingerprint(c, first));
});
