/** Test-action parts reference shared file lists and are pruned to a size cap, oldest unnamed first [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { packTestResults } from '../../../../index.js';
import { temporaryDirectory } from '../../../../../board/tests/fixtures/board.js';
import {
  firstChangedInput,
  recordInputParts,
} from '../../../../index.js';
import {
  enforcePartsCap,
  maintainPartsStore,
  prunePartsStore,
} from '../../../../index.js';

const DAY = 86_400_000;
const hash = (character) => character.repeat(64);

/** A [path, blob] list of the given length, with an optional changed blob. */
function fileList(count, changed) {
  return Array.from({ length: count }, (_, index) => [`src/file-${index}.js`, (changed === index ? 'b' : 'a').repeat(40)]);
}

/** Write one JSON record into a store folder, aged by the given days. */
function put(store, folder, name, value, days = 0) {
  mkdirSync(join(store, folder), { recursive: true });
  const path = join(store, folder, name);
  writeFileSync(path, JSON.stringify(value));
  const at = new Date(Date.now() - days * DAY);
  utimesSync(path, at, at);
  return path;
}

test('gate.io-test-action-prune.a-part-for-an-unchanged-tree: clause 1: a part for an unchanged tree adds under 2 KB because it names the shared file list, and lookups resolve the same inputs [C7]', () => {
  const store = temporaryDirectory('parts-shared-');
  const runner = fileList(300);
  const first = { test: 'src/file-0.js', files: fileList(4000), runner, inputs: [], tracked: null, options: [] };
  recordInputParts(store, hash('1'), first);
  const before = readdirSync(join(store, 'lists')).length;
  recordInputParts(store, hash('2'), { ...first, test: 'src/file-1.js' });
  assert.equal(readdirSync(join(store, 'lists')).length, before, 'the second part adds no file list');
  assert.ok(statSync(join(store, 'parts-ref', `${hash('2')}.json`)).size < 2048, 'the second part is a reference, not a manifest');
  assert.equal(existsSync(join(store, 'parts')), false, 'nothing is written where an older reader looks');
  recordInputParts(store, hash('3'), { ...first, files: fileList(4000, 17) });
  assert.equal(firstChangedInput(store, { inputKey: hash('1'), context: {} }, { inputKey: hash('3'), context: {} }), 'import src/file-17.js');
  put(store, 'parts', `${hash('4')}.json`, { ...first, files: fileList(4000, 17) });
  assert.equal(firstChangedInput(store, { inputKey: hash('1'), context: {} }, { inputKey: hash('4'), context: {} }), 'import src/file-17.js', 'a part written before lists existed still resolves');
});

/** A store with two named parts, three unnamed old parts of different ages, a fresh unnamed part and two lists. */
function populated() {
  const store = temporaryDirectory('parts-prune-');
  const pad = 'x'.repeat(1000);
  put(store, 'lists', `${hash('a')}.json`, [['a.js', 'a'.repeat(40)]], 5);
  put(store, 'lists', `${hash('b')}.json`, [['b.js', 'b'.repeat(40)]], 5);
  put(store, 'parts-ref', `${hash('1')}.json`, { files: hash('a'), runner: hash('a'), pad }, 5);
  put(store, 'parts-ref', `${hash('2')}.json`, { files: hash('a'), runner: hash('a'), pad }, 5);
  put(store, 'parts-ref', `${hash('c')}.json`, { files: hash('b'), runner: hash('b'), pad }, 4);
  put(store, 'parts-ref', `${hash('d')}.json`, { files: hash('b'), runner: hash('b'), pad }, 3);
  put(store, 'parts-ref', `${hash('e')}.json`, { files: hash('b'), runner: hash('b'), pad }, 2);
  put(store, 'parts-ref', `${hash('f')}.json`, { files: hash('b'), runner: hash('b'), pad }, 0);
  put(store, 'keys/identity', 'one.json', { identity: 'identity', file: 'one', value: { inputKey: hash('1'), key: hash('9'), reason: '' } });
  put(store, 'green', `${hash('8')}.json`, { key: hash('8'), inputKey: hash('2'), status: 'pass' });
  return store;
}

/** The part names left in a store. */
const left = (store) => readdirSync(join(store, 'parts-ref')).map(name => name.slice(0, 1)).sort();

test('gate.io-test-action-prune.a-prune-removes-unnamed-parts-and: clause 2: a prune removes unnamed parts and lists, oldest first, only until the folder is under the cap, and never a named record [C7]', () => {
  const store = populated();
  const size = (name) => statSync(join(store, 'parts-ref', `${hash(name)}.json`)).size;
  const total = [...readdirSync(join(store, 'parts-ref')).map(name => statSync(join(store, 'parts-ref', name)).size),
    ...readdirSync(join(store, 'lists')).map(name => statSync(join(store, 'lists', name)).size)].reduce((sum, bytes) => sum + bytes, 0);
  const result = prunePartsStore(store, { capBytes: total - size('c') - size('d'), maxAgeMs: Infinity });
  assert.equal(result.removedParts, 2);
  assert.deepEqual(left(store), ['1', '2', 'e', 'f'], 'the two oldest unnamed parts went; newer and named ones stayed');
  assert.ok(existsSync(join(store, 'lists', `${hash('b')}.json`)), 'a list a remaining part names stays');
  const all = prunePartsStore(store, { capBytes: 0, maxAgeMs: Infinity });
  assert.deepEqual(left(store), ['1', '2', 'f'], 'the cap cannot remove a named part or one younger than the grace period');
  assert.equal(all.removedParts, 1);
  assert.ok(existsSync(join(store, 'lists', `${hash('a')}.json`)));
});

test('gate.io-test-action-prune.a-list-no-remaining-part-names: clause 2: a list no remaining part names is removed once the parts are gone, and maintenance prunes at most once per interval under the configured cap [C7]', () => {
  const store = populated();
  put(store, 'parts-ref', `${hash('f')}.json`, { files: hash('b'), runner: hash('b'), pad: 'x' }, 3);
  const result = maintainPartsStore(store, { PULLBOARD_TEST_PARTS_CAP_BYTES: '1' });
  assert.deepEqual(left(store), ['1', '2'], 'every unnamed part went under a one byte cap');
  assert.equal(result.removedLists, 1);
  assert.equal(existsSync(join(store, 'lists', `${hash('b')}.json`)), false);
  assert.equal(existsSync(join(store, 'lists', `${hash('a')}.json`)), true);
  assert.equal(maintainPartsStore(store, { PULLBOARD_TEST_PARTS_CAP_BYTES: '1' }), null, 'a second call inside the interval does nothing');
});

test('gate.io-test-action-prune.a-part-named-only-by-a: clause 2: a part named only by a retained runner completion survives the prune [C7]', () => {
  const store = populated();
  const packet = packTestResults([{ inputKey: hash('c'), status: 'pass', key: hash('7') }]);
  assert.ok(packet, 'the completion packet packs');
  put(store, 'completions', 'completion-1.json', { id: 'completion-1', code: 0, testResults: packet });
  const result = prunePartsStore(store, { capBytes: 0 });
  assert.deepEqual(left(store), ['1', '2', 'c', 'f'], 'the completion keeps part c; the other unnamed old parts went');
  assert.equal(result.removedParts, 2);
});

test('gate.io-test-action-prune.an-unnamed-part-or-list-older: clause 2: an unnamed part or list older than the age cap is removed even under the size cap, and a named or newer one stays [C7]', () => {
  const store = populated();
  put(store, 'lists', `${hash('c')}.json`, [['c.js', 'c'.repeat(40)]], 4);
  const result = prunePartsStore(store, { capBytes: 1024 ** 4, maxAgeMs: 2.5 * DAY });
  assert.deepEqual(left(store), ['1', '2', 'e', 'f'], 'parts c and d passed the age cap; named 1 and 2 stay at five days old');
  assert.equal(result.removedParts, 2);
  assert.equal(result.removedLists, 1, 'only the list no part names went');
  assert.equal(existsSync(join(store, 'lists', `${hash('c')}.json`)), false);
  assert.ok(existsSync(join(store, 'lists', `${hash('a')}.json`)) && existsSync(join(store, 'lists', `${hash('b')}.json`)));
  const later = populated();
  maintainPartsStore(later, { PULLBOARD_TEST_PARTS_MAX_AGE_MS: String(2.5 * DAY) });
  assert.deepEqual(left(later), ['1', '2', 'e', 'f'], 'maintenance reads the configured age cap');
});

test('gate.io-test-action-prune.the-test-actions-lists-folder-stays: clause 1: the test-actions lists folder stays under its cap under continuous writes, pruned on write and oldest first [C7]', () => {
  const store = temporaryDirectory('parts-cap-');
  const cap = 200_000;
  let now = Date.now();
  let peak = 0;
  for (let round = 0; round < 60; round += 1) {
    const list = Array.from({ length: 300 }, (_, index) => [`src/r${round}-${index}.js`, 'a'.repeat(40)]);
    recordInputParts(store, round.toString(16).padStart(64, '0'), { test: `t${round}.js`, files: list, runner: [], inputs: [], tracked: null, options: [] });
    now += 11 * 60_000;
    enforcePartsCap(store, { PULLBOARD_TEST_PARTS_CAP_BYTES: String(cap) }, now);
    const after = readdirSync(join(store, 'lists')).map(name => statSync(join(store, 'lists', name)).size).reduce((sum, bytes) => sum + bytes, 0);
    peak = Math.max(peak, after);
  }
  assert.ok(peak <= cap, `the lists folder never stays over the cap after a write (peak ${peak})`);
  assert.ok(readdirSync(join(store, 'lists')).length > 1, 'the newest lists stay; only the oldest went');
});
