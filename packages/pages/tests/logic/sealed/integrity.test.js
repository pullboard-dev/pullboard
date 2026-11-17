/** Sealed page integrity, bounded objects and selected-value reads [H15,H17]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import {
  generateBoardKey,
  seal,
} from "../../../../kernel/index.js";
import {
  PAGE_BYTES,
  PAGE_CIPHER_BYTES,
  PAGE_FANOUT,
  pageDigest,
  readSealedDescriptor,
  readSealedBytes,
  readSealedValue,
  writeSealedValue,
  writeSealedDescriptor,
} from "../../../index.js";

/** Retain only synthetic encrypted objects, with a distinct private reuse cache and observable reads. */
async function storage() {
  const objects = new Map();
  const fingerprints = new Map();
  const requested = [];
  const paths = [];
  const key = await generateBoardKey();
  const context = {
    key, boardId: 'a'.repeat(32), sequence: 7,
    /** Keep upload metadata distinct from the private plaintext fingerprint callback. */
    put(object) {
      assert.deepEqual(Object.keys(object).sort(), ['bytes', 'children', 'id', 'sequence']);
      assert.ok(object.bytes.byteLength <= PAGE_CIPHER_BYTES);
      assert.ok(object.children.length <= PAGE_FANOUT);
      objects.set(object.id, { ...object, bytes: Uint8Array.from(object.bytes) });
    },
    /** Count reads without returning device cache metadata. */
    get(id, parents = []) {
      requested.push(id);
      paths.push([...parents, id]);
      const found = objects.get(id);
      if (!found) throw new Error('Synthetic encrypted object is absent.');
      return found.bytes;
    },
    /** Reuse a trusted device-private cache across authenticated snapshot positions. */
    lookup(fingerprint) { return fingerprints.get(fingerprint); },
    /** The fingerprint is deliberately absent from every uploaded object. */
    remember(fingerprint, reference) { fingerprints.set(fingerprint, reference); },
  };
  return { objects, requested, paths, context };
}

test('pages.integrity.sealed-json-exceeds-one-full-index: sealed JSON exceeds one full index while every uploaded object stays bounded [H15,H17]', async () => {
  const box = await storage();
  // Real UTF-8 characters cross leaf boundaries; this forces a second index level, not a larger manifest.
  const value = { marker: 'nested page fixture', text: '🙂'.repeat(Math.ceil(PAGE_BYTES * (PAGE_FANOUT + 1) / 4)) };
  const reference = await writeSealedValue(value, box.context);
  const restored = await readSealedValue(reference, box.context);
  assert.equal(restored.marker, value.marker);
  assert.equal(restored.text.length, value.text.length);
  assert.equal(createHash('sha256').update(restored.text).digest('hex'), createHash('sha256').update(value.text).digest('hex'));
  assert.equal(reference.bytes, Buffer.byteLength(JSON.stringify(value)));
  assert.ok([...box.objects.values()].some(object => object.children.length === PAGE_FANOUT), 'the complete bounded group became an index');
  assert.ok(box.objects.get(reference.id).children.length >= 2, 'a later bounded index combines the complete group and its remainder');
});

test('pages.integrity.private-reuse-preserves-authenticated-old-pages: private reuse preserves authenticated old pages without disclosing their fingerprints [H15,H17]', async () => {
  const box = await storage();
  const value = { text: 'retained history '.repeat(PAGE_BYTES / 8) };
  const first = await writeSealedValue(value, box.context);
  const count = box.objects.size;
  const second = await writeSealedValue(value, { ...box.context, sequence: 8 });
  assert.deepEqual(second, first);
  assert.equal(box.objects.size, count, 'unchanged history uploads no new cipher objects');
  assert.equal((await readSealedValue(second, box.context)).text.length, value.text.length);
  assert.ok([...box.objects.values()].every(object => !Object.hasOwn(object, 'fingerprint')));
});

test('pages.integrity.wrong-board-position-ciphertext-and-subtree: wrong board, position, ciphertext and subtree lengths cannot become snapshot data [H15,H17]', async () => {
  const box = await storage();
  const reference = await writeSealedValue({ marker: 'authenticated synthetic data' }, box.context);
  const remembered = [];
  const context = { ...box.context, rememberRead: (...args) => { remembered.push(args); } };
  await assert.rejects(readSealedValue(reference, { ...context, boardId: 'b'.repeat(32) }), { code: 'SEAL_AUTH_FAILED' });
  await assert.rejects(readSealedValue({ ...reference, sequence: 8 }, context), { code: 'SEAL_AUTH_FAILED' });
  await assert.rejects(readSealedValue({ ...reference, bytes: reference.bytes + 1 }, context), { code: 'SNAPSHOT_PAGE_FORMAT' });
  assert.equal(remembered.length, 0, 'neither misbound nor structurally invalid data can seed private reuse or remote-custody ACKs');
  assert.deepEqual(await readSealedValue(reference, context), { marker: 'authenticated synthetic data' });
  assert.equal(remembered.length, 1, 'a complete valid read can seed the private device cache');
  assert.equal(remembered[0][0].id, reference.id);
  assert.deepEqual(remembered[0][0].children, []);
  const bytes = box.objects.get(reference.id).bytes;
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(readSealedValue(reference, context), { code: 'SNAPSHOT_PAGE_FORMAT' });
  assert.equal(remembered.length, 1, 'tampered ciphertext cannot add or replace cached evidence');
});

test('pages.integrity.a-selected-value-reader-stops-fetching: a selected-value reader stops fetching when its consumer stops or has no allocation budget [H15,H17]', async () => {
  const box = await storage();
  const reference = await writeSealedValue({ text: 'x'.repeat(PAGE_BYTES * 3) }, box.context);
  box.requested.length = 0;
  await assert.rejects(readSealedValue(reference, box.context, { maxBytes: 1 }), { code: 'SNAPSHOT_PAGE_FORMAT' });
  assert.equal(box.requested.length, 0, 'allocation refusal precedes any remote read');
  for await (const bytes of readSealedBytes(reference, box.context)) {
    assert.equal(bytes.byteLength, PAGE_BYTES);
    break;
  }
  assert.equal(box.requested.length, 2, 'only the index and first leaf were fetched');
});

test('pages.integrity.an-authenticated-gzip-bomb-refuses-before: an authenticated gzip bomb refuses before a complete oversized page is allocated [H15,H17]', async () => {
  const box = await storage();
  const plain = Buffer.concat([Buffer.from('pullboard-sealed-page/1\n'), Buffer.of(1), Buffer.alloc(PAGE_BYTES + 1)]);
  const bytes = await seal(box.context.key, gzipSync(plain), { boardId: box.context.boardId, kind: 'snapshot', sequence: 7 });
  const id = await pageDigest(bytes);
  box.objects.set(id, { bytes });
  await assert.rejects(readSealedValue({ id, sequence: 7, bytes: PAGE_BYTES + 1 }, box.context), { code: 'SNAPSHOT_PAGE_FORMAT' });
});

test('pages.integrity.a-sealed-directory-exposes-only-its: a sealed directory exposes only its selected child and carries its pinned-root path [H15,H17]', async () => {
  const box = await storage();
  const selected = await writeSealedValue({ marker: 'SELECTED_ENCRYPTED_HISTORY_VALUE' }, box.context);
  const unrelated = await writeSealedValue({ marker: 'UNRELATED_ENCRYPTED_HISTORY_VALUE' }, box.context);
  const root = await writeSealedDescriptor({ selected, unrelated }, [selected, unrelated], box.context);
  box.requested.length = 0;
  const directory = await readSealedDescriptor(root, box.context);
  assert.deepEqual(directory.links, [selected, unrelated]);
  assert.deepEqual(box.requested, [root.id], 'reading the directory does not fetch its history');
  const value = await readSealedValue(directory.value.selected, { ...box.context, parents: [root.id] });
  assert.equal(value.marker, 'SELECTED_ENCRYPTED_HISTORY_VALUE');
  assert.deepEqual(box.paths.at(-1), [root.id, selected.id]);
  assert.ok(!box.requested.includes(unrelated.id));
  assert.deepEqual(box.objects.get(root.id).children, [selected.id, unrelated.id]);
});
