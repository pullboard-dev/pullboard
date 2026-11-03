/** Submit and landing select only unsealed packages' tests plus contracts at changed front doors (RFC 0006 A3) [C7,CD44]. */
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
import {
  recordSeal,
  requireSealedSkips,
  sealStatus,
  sealStoreFile,
  selectTestTiers,
  testTierReport,
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
function fixture(t) {
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
  for (const row of sealStatus(root, { rev: first, store })) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package.replace('packages/', '')}`], tests: [] });
  return { root, first };
}

test('a change inside one package runs only that package\'s tests and skips sealed packages by receipt [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.deepEqual(plan.units, [BASE_TEST]);
  assert.deepEqual(plan.skipped, [{ package: 'packages/alone', hash: plan.skipped[0].hash, receipt: 'receipt-alone' }]);
  assert.ok(plan.journeys.includes(CONTRACT) && plan.journeys.includes(USER_TEST), 'an unchanged front door runs no contract and no importer');
  assert.match(testTierReport(plan), /^Sealed packages skipped \(1\): packages\/alone by receipt receipt-alone$/mu);
  assert.doesNotThrow(() => requireSealedSkips(root, plan));
});

test('a changed front door runs its contracts and unseals and runs its importers [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const zero = 0;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.deepEqual(plan.units, [CONTRACT, BASE_TEST, USER_TEST]);
  assert.ok(plan.packages.includes('packages/user'));
  assert.deepEqual(plan.skipped.map(row => [row.package, row.receipt]), [['packages/alone', 'receipt-alone']]);
  assert.deepEqual(plan.journeys, ['test/journey.test.js'], 'journeys wait for the landing batch');
});

test('control: a plan that hides a real change from its run fails, so skip logic never reports a false green [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const one = 1;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  const hidden = { ...plan, units: plan.units.filter(file => file !== USER_TEST), skipped: [...plan.skipped, { package: 'packages/user', hash: null, receipt: 'receipt-user' }] };
  assert.throws(() => requireSealedSkips(root, hidden), { code: 'SEAL_STALE', message: /packages\/user/u });
  assert.throws(() => requireSealedSkips(root, { ...plan, base: null }), { code: 'SEAL_STALE' });
});
