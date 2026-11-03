/** An item proves once: review cites sealed verdicts, landing adds only composition and journeys (RFC 0006 A4, A5) [C7,CD44]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  citedReceipts,
  citedReceiptsNote,
  landingRunFiles,
  recordSeal,
  reviewCitations,
  sealStatus,
  sealStoreFile,
  selectTestTiers,
  writeTestTiers,
} from '../packages/gate/index.js';
import { runFixtureGit } from './fixture-child.js';


const IDENTITY = ['-c', 'user.name=Seal Test', '-c', 'user.email=seal@example.test', '-c', 'commit.gpgsign=false'];
const BASE_TEST = 'packages/base/tests/base.test.js';
const CONTRACT = 'packages/base/contract/user.test.js';
const USER_TEST = 'packages/user/tests/user.test.js';

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

/**
 * base is imported by user; alone imports nothing. base carries a consumer contract that opens a board (so it is never
 * a plain unit), user's own test crosses into base, and one root journey spans packages. Candidate tests never run here.
 */
function fixture(t, { unsealed = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-seal-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  const files = {
    'package.json': '{"type":"module"}\n',
    'packages/base/index.js': 'export { add } from "./src/core/add.js";\n',
    'packages/base/src/core/add.js': 'export const add = (a, b) => a + b;\n',
    [BASE_TEST]: 'import { add } from "../index.js";\nadd(1, 2);\n',
    [CONTRACT]: 'import { add } from "../index.js";\nfake.openBoard(":memory:");\nadd(1, 2);\n',
    'packages/user/index.js': 'export { total } from "./src/core/total.js";\n',
    'packages/user/src/core/total.js': 'import { add } from "../../../base/index.js";\nexport const total = rows => rows.reduce(add, 0);\n',
    [USER_TEST]: 'import { total } from "../index.js";\ntotal([1]);\n',
    'packages/alone/index.js': 'export const alone = 1;\n',
    'packages/alone/tests/alone.test.js': 'import { alone } from "../index.js";\nvoid alone;\n',
    'test/journey.test.js': 'import "../packages/alone/index.js";\nimport "../packages/user/index.js";\nimport { spawnSync } from "node:child_process";\nspawnSync("git");\n',
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  writeTestTiers(root);
  const first = commit(root, {});
  const store = sealStoreFile(root);
  for (const row of sealStatus(root, { rev: first, store })) if (!unsealed.includes(row.package)) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package.replace('packages/', '')}`], tests: [] });
  return { root, first };
}

const ALONE_TEST = 'packages/alone/tests/alone.test.js';

test('a reviewed item whose packages are sealed records a verdict citing their receipts without re-running their tests [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.ok(!plan.units.includes(ALONE_TEST), 'the sealed package\'s tests are not re-run');
  const cited = reviewCitations(root, plan);
  assert.deepEqual(cited.map(row => [row.package, row.receipt]), [['packages/alone', 'receipt-alone']]);
  const note = citedReceiptsNote(cited);
  assert.match(note, /^cited sealed verdicts: packages\/alone@[0-9a-f]{12} by receipt receipt-alone$/mu);
  assert.deepEqual(citedReceipts(`reviewed${note}`).map(row => row.receipt), ['receipt-alone'], 'the verdict note records what it relied on');
  assert.equal(citedReceiptsNote(reviewCitations(root, { ...plan, skipped: [] })), '', 'a review citing nothing records no line');
});

test('a landing re-runs only the composition journeys and the units no submit proved [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const three = 3;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.ok(plan.units.includes(BASE_TEST) && plan.units.includes(USER_TEST));
  const files = landingRunFiles(plan, new Set(plan.units.filter(file => file !== USER_TEST)));
  assert.deepEqual(files, [...new Set([...plan.journeys, USER_TEST])].sort());
  assert.ok(!files.includes(BASE_TEST), 'a unit the item\'s submit proved is not repeated');
});

test('a package unsealed after review is re-proved, not cited [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const reviewed = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const review = selectTestTiers(root, { base: first, commit: reviewed });
  assert.equal(reviewCitations(root, review).length, 1);
  const moved = commit(root, { 'packages/alone/index.js': 'export const alone = 2;\n' });
  const landing = selectTestTiers(root, { base: first, commit: moved });
  assert.ok(landing.units.includes(ALONE_TEST), 'the moved package runs its tests');
  assert.deepEqual(landing.skipped, [], 'and is no longer skipped');
  assert.throws(() => reviewCitations(root, { ...review, commit: moved }), { code: 'SEAL_STALE', message: /packages\/alone/u });
});

test('control: a citation that hides a real change from the run fails, never a false green [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  const hidden = { ...plan, units: plan.units.filter(file => file !== BASE_TEST), skipped: [...plan.skipped, { package: 'packages/base', hash: null, receipt: 'receipt-base' }] };
  assert.throws(() => reviewCitations(root, hidden), { code: 'SEAL_STALE', message: /packages\/base/u });
});
