/** Explicitly SYNTHETIC structural release envelopes: none is a native gate, custody or production execution receipt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RELEASE_RECEIPT_MAX_BYTES,
  readReleaseReceipt,
  releaseReceiptBody,
  releaseReceiptFields,
  releaseReceiptProblem,
  releaseParticipationDigest,
} from '../../../../../../packages/gate/index.js';
import {
  receiptBody,
  receiptFields,
} from '../../../../../../packages/gate/index.js';

/** Hash synthetic command and collection data using the native digest format, without claiming they ran. */
function digest(text) { return createHash('sha256').update(text).digest('hex'); }

/** Build a clearly synthetic registry-sized complete partition for pure structural checks only. */
function fixture(count = 8) {
  const required = Array.from({ length: count }, (_, i) => `synthetic-executor-${i + 1}`);
  const files = required.map((_, i) => `test/synthetic-${i + 1}.test.js`).sort();
  const expected = { head: 'a'.repeat(40), tree: 'b'.repeat(40), command: digest('synthetic accepted full gate'), required };
  const id = '6af8c70a-65f0-4a61-8040-3f1f278d9a10';
  const gateReceipt = { version: 1, id: 'ff6e3e7b-df07-4ff1-a84f-378aeb883705', kind: 'release',
    head: expected.head, tree: expected.tree, main: expected.head, command: expected.command,
    green: true, failures: [], load: { average: [0, 0, 0], cpus: 8, freeMB: 4096 }, at: '2026-10-27T10:01:00.000Z',
    collection: { version: 1, mode: 'all', batchId: id, full: true, complete: true, files,
      plannedFiles: files.length, completedFiles: files.length, planDigest: digest(JSON.stringify(files)), completedDigest: digest(JSON.stringify(files)) } };
  const participation = { version: 1, id, head: expected.head, tree: expected.tree, command: expected.command, required,
    shards: files.map((file, i) => ({ shard: `synthetic-shard-${i + 1}`, files: [file], executor: required[i],
      head: expected.head, tree: expected.tree, command: digest(`synthetic shard ${file}`), green: true, complete: true, cleanupVerified: true })),
    startedAt: '2026-10-27T10:00:00.000Z', finishedAt: '2026-10-27T10:02:00.000Z' };
  gateReceipt.participationDigest = releaseParticipationDigest(participation);
  return { expected, envelope: { version: 1, gateReceipt, participation } };
}

export { fixture as releaseReceiptFixture };

/** Register bounded structural controls; the importing frozen wrapper owns whether these tests execute. */
export function installReleaseReceiptCases() {
  for (const count of [1, 7]) {
    test(`synthetic release receipt records exactly ${count} required executors [C7,V4]`, () => {
      const { envelope, expected } = fixture(count);
      assert.equal(releaseReceiptProblem(envelope, expected), null);
      const receipt = releaseReceiptFields(envelope, expected);
      assert.equal(receipt.participation.required.length, count);
      assert.equal(new Set(receipt.participation.shards.map(shard => shard.executor)).size, count);
      assert.equal(receipt.gateReceipt.collection.completedFiles, count);
    });
  }
  test('synthetic release receipt refuses an empty required registry [C7,V4]', () => {
    const { envelope, expected } = fixture();
    expected.required = [];
    envelope.participation.required = [];
    assert.notEqual(releaseReceiptProblem(envelope, expected), null);
  });

  test('synthetic release structure binds complete collection and all eight expected executors [C7,V4]', () => {
    const { envelope, expected } = fixture();
    assert.equal(releaseReceiptProblem(envelope, expected), null);
    const body = releaseReceiptBody(envelope, expected);
    assert.equal(typeof body, 'string');
    assert.equal(releaseReceiptBody(JSON.parse(body), expected), body);
    assert.equal(releaseReceiptFields(envelope, expected).gateReceipt.kind, 'release');
    const reordered = structuredClone(envelope);
    reordered.participation.required.reverse();
    reordered.participation.shards.reverse();
    assert.equal(releaseReceiptBody(reordered, expected), body, 'canonical field order is independent of supplied participant order');
    assert.equal(Object.hasOwn(JSON.parse(body), 'auditBatchId'), false, 'standalone release structure never invents a landing audit');
    const legacyBody = '{"version":1,"id":"ff6e3e7b-df07-4ff1-a84f-378aeb883705","kind":"land","tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","main":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","command":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","green":true,"failures":[],"load":{"average":[0,0,0],"cpus":8,"freeMB":4096},"at":"2026-10-27T10:01:00.000Z"}\n';
    const ordinary = JSON.parse(legacyBody);
    assert.equal(receiptBody(ordinary), legacyBody, 'ordinary land bytes retain their legacy field layout');
    assert.equal(receiptFields({ ...ordinary, participationDigest: 'a'.repeat(64) }), null, 'release binding cannot be mixed into landing custody');
  });

  test('release structure rejects wrong source gate command run identity and incomplete native collection [C7,V4]', () => {
    const mutations = [
      e => { e.gateReceipt.head = 'c'.repeat(40); },
      e => { e.gateReceipt.tree = 'c'.repeat(40); },
      e => { e.gateReceipt.command = digest('another full gate'); },
      e => { e.gateReceipt.kind = 'land'; },
      e => { delete e.gateReceipt.participationDigest; },
      e => { e.gateReceipt.participationDigest = '0'.repeat(64); },
      e => { e.gateReceipt.green = false; },
      e => { e.gateReceipt.collection.full = false; },
      e => { e.gateReceipt.collection.complete = false; },
      e => { e.gateReceipt.collection.completedFiles--; },
      e => { e.gateReceipt.collection.completedDigest = '0'.repeat(64); },
      e => { e.gateReceipt.collection.planDigest = '0'.repeat(64); },
      e => { e.participation.id = 'different-release'; },
      e => { e.participation.head = 'c'.repeat(40); },
      e => { e.participation.tree = 'c'.repeat(40); },
      e => { e.participation.command = digest('different accepted gate'); },
    ];
    for (const mutate of mutations) {
      const { envelope, expected } = fixture();
      mutate(envelope);
      assert.notEqual(releaseReceiptProblem(envelope, expected), null);
      assert.equal(releaseReceiptBody(envelope, expected), null);
    }
  });

  test('release partition rejects missing duplicated foreign or unclean shards and omitted executors [C7,V4]', () => {
    const mutations = [
      e => { e.participation.shards.pop(); },
      e => { e.participation.shards[0].files.push(e.participation.shards[1].files[0]); },
      e => { e.participation.shards[0].files = ['test/not-planned.test.js']; },
      e => { e.participation.shards[0].files = []; },
      e => { e.participation.shards[0].executor = e.participation.shards[1].executor; },
      e => { e.participation.shards[0].executor = 'foreign-executor'; },
      e => { e.participation.required[0] = 'foreign-executor'; },
      e => { e.participation.required.pop(); },
      e => { e.participation.required[0] = e.participation.required[1]; },
      e => { e.participation.shards[0].head = 'c'.repeat(40); },
      e => { e.participation.shards[0].tree = 'c'.repeat(40); },
      e => { e.participation.shards[0].command = 'node ./bin/run-tests.js'; },
      e => { e.participation.shards[0].command = '0'.repeat(64); },
      e => { e.participation.shards[0].green = false; },
      e => { e.participation.shards[0].complete = false; },
      e => { e.participation.shards[0].cleanupVerified = false; },
      e => { e.participation.shards[0].shard = e.participation.shards[1].shard; },
    ];
    for (const mutate of mutations) {
      const { envelope, expected } = fixture();
      mutate(envelope);
      assert.notEqual(releaseReceiptProblem(envelope, expected), null);
    }
  });

  test('release structure refuses unknown fields malformed dates oversized data and malformed expectations [C7,V4]', () => {
    const mutations = [
      e => { e.authority = 'invented'; },
      e => { e.gateReceipt.nativeAuthority = true; },
      e => { e.gateReceipt.collection.assumedComplete = true; },
      e => { e.participation.auditBatchId = 'invented'; },
      e => { e.participation.shards[0].trusted = true; },
      e => { e.participation.startedAt = 'yesterday'; },
      e => { e.participation.finishedAt = '2026-10-27T09:59:00.000Z'; },
      e => { e.participation.startedAt = '2026-10-27T10:01:30.000Z'; },
      e => { e.gateReceipt.at = '2026-02-30T10:01:00.000Z'; },
      e => { e.participation.finishedAt = '2026-10-27T10:02:00Z'; },
      e => { e.participation.id = 'x'.repeat(RELEASE_RECEIPT_MAX_BYTES + 1); },
    ];
    for (const mutate of mutations) {
      const { envelope, expected } = fixture();
      mutate(envelope);
      assert.notEqual(releaseReceiptProblem(envelope, expected), null);
    }
    const { envelope, expected } = fixture();
    assert.notEqual(releaseReceiptProblem(envelope, { ...expected, required: expected.required.slice(1) }), null);
    assert.notEqual(releaseReceiptProblem(envelope, { ...expected, command: 'not-a-digest' }), null);
    assert.notEqual(releaseReceiptProblem(envelope, null), null);
    envelope.participation.self = envelope;
    assert.notEqual(releaseReceiptProblem(envelope, expected), null, 'cyclic non-JSON input is refused without throwing');
  });

  test('local release reader accepts canonical synthetic bytes only and grants no native custody [C7,V4]', t => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-synthetic-release-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'receipt.json');
    const { envelope, expected } = fixture();
    const body = releaseReceiptBody(envelope, expected);
    writeFileSync(file, body);
    assert.deepEqual(readReleaseReceipt(file, expected), releaseReceiptFields(envelope, expected));
    writeFileSync(file, JSON.stringify(envelope, null, 2));
    assert.equal(readReleaseReceipt(file, expected), null);
    writeFileSync(file, body);
    const link = join(directory, 'linked.json');
    symlinkSync(file, link);
    assert.equal(readReleaseReceipt(link, expected), null);
    assert.equal(readReleaseReceipt(directory, expected), null);
    assert.equal(readReleaseReceipt(join(directory, 'missing.json'), expected), null);
    writeFileSync(file, ' '.repeat(RELEASE_RECEIPT_MAX_BYTES + 1));
    assert.equal(readReleaseReceipt(file, expected), null);
  });
}
