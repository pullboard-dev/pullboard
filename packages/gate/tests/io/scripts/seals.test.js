/** Package seals: content-hash verdicts, computed unsealing, and a skip that can never report a false green [C7,CD44]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkSkippedSeals,
  packageHashesAt,
  recordSeal,
  sealOf,
  sealStatus,
  unsealedPackages,
} from '../../../heavy.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../fixtures/child.js';

const command = fileURLToPath(new URL('../../../src/io/scripts/seals.js', import.meta.url));
const IDENTITY = ['-c', 'user.name=Seal Test', '-c', 'user.email=seal@example.test', '-c', 'commit.gpgsign=false'];

/** Write files into a private repository and commit them, returning the new commit id. */
function commit(root, files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/** Three packages: base, its importer through the front door, and one that imports neither. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-seals-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  const first = commit(root, {
    'package.json': '{"type":"module","imports":{"#*":"./packages/*/index.js"}}',
    'packages/base/index.js': 'export { add } from "./src/core/add.js";\n',
    'packages/base/src/core/add.js': 'export const add = (a, b) => a + b;\n',
    'packages/base/assets/rates.json': '{"rate":1}\n',
    'packages/user/index.js': 'export { total } from "./src/core/total.js";\n',
    'packages/user/src/core/total.js': 'import { add } from "#base";\nexport const total = (rows) => rows.reduce(add, 0);\n',
    'packages/alone/index.js': 'export const alone = 1;\n',
  });
  return { root, first, store: join(root, '.git', 'pullboard', 'seals.sqlite') };
}

/** Seal every package at a revision as if its tests were green under one receipt. */
function sealAll(root, store, rev) {
  for (const row of sealStatus(root, { rev, store })) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package}`], tests: [] });
}

test('gate.io-scripts-seals.changing-one-internal-file-unseals-only: changing one internal file unseals only its package; a changed front door unseals its importers and nothing else [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const inner = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  assert.deepEqual(unsealedPackages(root, { base: first, head: inner }).unsealed.map(row => row.package), ['packages/base']);
  const door = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const zero = 0;\n' });
  const result = unsealedPackages(root, { base: inner, head: door });
  assert.deepEqual(result.unsealed.map(row => row.package), ['packages/base', 'packages/user']);
  assert.equal(result.unsealed[1].reason, 'front door packages/base/index.js');
  assert.deepEqual(result.kept, ['.', 'packages/alone']);
  const asset = commit(root, { 'packages/base/assets/rates.json': '{"rate":2}\n' });
  assert.deepEqual(unsealedPackages(root, { base: door, head: asset }).unsealed.map(row => row.package), ['packages/base'], 'assets key their package');
});

test('gate.io-scripts-seals.an-unchanged-package-keeps-its-seal: an unchanged package keeps its seal and receipts across commits; the command lists what a change unseals [C7,CD44]', t => {
  const { root, first, store } = fixture(t);
  sealAll(root, store, first);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const one = 1;\n' });
  const status = new Map(sealStatus(root, { rev: head, store }).map(row => [row.package, row]));
  assert.deepEqual(status.get('packages/alone').seal.receipts, ['receipt-packages/alone']);
  assert.equal(status.get('packages/base').seal, null);
  assert.equal(status.get('packages/user').seal, null);
  assert.equal(sealOf(store, 'packages/alone', status.get('packages/alone').hash).package, 'packages/alone');
  assert.throws(() => recordSeal(store, { package: 'packages/base', hash: status.get('packages/base').hash, receipts: [], tests: [] }), { code: 'SEAL_RECEIPTS' });
  const shown = runFixtureChild(process.execPath, [command, 'unsealed', first, head, '--root', root], { cwd: root, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.context);
  assert.equal(shown.stdout, 'packages/base  files\npackages/user  front door packages/base/index.js\n2 unsealed, 2 keep their seal\n');
});

test('gate.io-scripts-seals.a-package-hash-is-stable-across: a package hash is stable across checkouts and machines [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const copy = mkdtempSync(join(tmpdir(), 'pullboard-seals-clone-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  runFixtureGit(['clone', '-q', '--no-hardlinks', root, join(copy, 'elsewhere')], { cwd: copy });
  const hashes = rows => new Map([...rows].map(([name, row]) => [name, row.hash]));
  const [here] = packageHashesAt(root, [first]);
  const [there] = packageHashesAt(join(copy, 'elsewhere'), [first]);
  assert.deepEqual(hashes(there), hashes(here));
  const [again] = packageHashesAt(root, ['HEAD']);
  assert.deepEqual(hashes(again), hashes(here));
});

test('gate.io-scripts-seals.control-a-selection-that-hides-a: control: a selection that hides a real change from its run fails, so skip logic never reports a false green [C7,CD44]', t => {
  const { root, first, store } = fixture(t);
  sealAll(root, store, first);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const two = 2;\n' });
  const { unsealed, kept } = unsealedPackages(root, { base: first, head });
  assert.doesNotThrow(() => checkSkippedSeals(root, { rev: head, skipped: kept, store }));
  const hidden = [...kept, unsealed.find(row => row.package === 'packages/user').package];
  assert.throws(() => checkSkippedSeals(root, { rev: head, skipped: hidden, store }), { code: 'SEAL_STALE', message: /packages\/user/u });
});

test('gate.io-scripts-seals.a-committed-cell-plan-owns-its: a committed cell plan owns its legacy paths: changing one unseals the declared cell, and unrelated packages keep their seals [C7,CD44]', t => {
  const { root, store } = fixture(t);
  const planned = commit(root, {
    'packages/codemap/data/plan/cells.json': JSON.stringify({ version: 1, cells: [{ order: 1, name: 'legacy', file: 'packages/codemap/data/plan/01-legacy.json' }] }),
    'packages/codemap/data/plan/01-legacy.json': JSON.stringify({ name: 'legacy', root: 'packages/legacy', frontDoor: 'packages/legacy/index.js',
      paths: [['src/old.js', 'packages/legacy/src/core/old.js', 'seed']] }),
    'packages/legacy/index.js': 'export { old } from "../../src/old.js";\n',
    'src/old.js': 'export const old = 1;\n',
  });
  sealAll(root, store, planned);
  const head = commit(root, { 'src/old.js': 'export const old = 2;\n' });
  const { unsealed, kept } = unsealedPackages(root, { base: planned, head });
  assert.deepEqual(unsealed.map(row => row.package), ['packages/legacy']);
  // The plan lives under packages/codemap, so that folder is a fixture package that the source change leaves sealed.
  assert.deepEqual(kept, ['.', 'packages/alone', 'packages/base', 'packages/codemap', 'packages/user']);
  const status = new Map(sealStatus(root, { rev: head, store }).map(row => [row.package, row.seal]));
  assert.equal(status.get('packages/legacy'), null);
  for (const name of kept) assert.deepEqual(status.get(name).receipts, [`receipt-${name}`], name);
  assert.throws(() => checkSkippedSeals(root, { rev: head, skipped: [...kept, 'packages/legacy'], store }), { code: 'SEAL_STALE' });
});
