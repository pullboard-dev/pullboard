/** The completeness guard accepts what the selection rightly leaves out: root-owned cross-package journeys (#2596) [C7,CD44]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  recordSeal,
  requireSealedSkips,
  sealStatus,
  sealStoreFile,
  selectTestTiers,
  submitGatePlan,
  writeTestTiers,
} from '../../../../index.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';

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


/** #2479's three root-owned tests, each importing only two packages, so the tiers file them as cross-package journeys. */
const JOURNEYS = ['apps/view/tests/logic/pipeline/model.test.js', 'apps/relay/tests/io/browser/history.test.js', 'apps/relay/tests/logic/browser/stream.test.js'];
const SOURCE = 'import "../packages/base/index.js";\nimport "../packages/user/index.js";\n';

/** The seal fixture plus #2479's journeys and a root source file, so a change can unseal the root package. */
function rootFixture(t) {
  const { root } = fixture(t);
  const files = Object.fromEntries(JOURNEYS.map(file => [file, file.split('/').length > 2 ? SOURCE.replaceAll('../', '../../') : SOURCE]));
  commit(root, { ...files, 'lib/root.js': 'export const root = 1;\n' });
  writeTestTiers(root);
  const base = commit(root, {});
  const store = sealStoreFile(root);
  for (const row of sealStatus(root, { rev: base, store })) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package}`], tests: [] });
  return { root, base };
}

test('a landing batch that unseals the root package passes the guard with its root journeys left out [C7,CD44]', t => {
  const { root, base } = rootFixture(t);
  const head = commit(root, { 'lib/root.js': 'export const root = 2;\n', 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  for (const file of JOURNEYS) assert.ok(!plan.units.includes(file), `${file} is a journey, not a unit`);
  assert.doesNotThrow(() => requireSealedSkips(root, plan), 'the landing plan reaches its gate');
});

test('an ordinary submit touching the same packages passes, and a dropped real unit still refuses [C7,CD44]', t => {
  const { root, base } = rootFixture(t);
  commit(root, { 'lib/root.js': 'export const root = 3;\n', 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = submitGatePlan(root, { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] }, { base });
  assert.doesNotThrow(() => requireSealedSkips(root, plan.testTiers, { proofFiles: plan.proofFiles, check: plan.check }));
  const unrun = plan.proofFiles.filter(file => file !== BASE_TEST);
  assert.throws(() => requireSealedSkips(root, plan.testTiers, { proofFiles: unrun, check: plan.check }),
    { code: 'TEST_SELECTION_INCOMPLETE', message: /missing from the submit run: packages\/base\/tests\/base\.test\.js/u });
  const dropped = { ...plan.testTiers, units: plan.testTiers.units.filter(file => file !== BASE_TEST) };
  assert.throws(() => requireSealedSkips(root, dropped), { code: 'TEST_SELECTION_INCOMPLETE', message: /packages\/base\/tests\/base\.test\.js/u });
});


test('global policy changes keep unsealed importer units and defer root cross-package journeys [C7]', t => {
  const { root, base } = rootFixture(t);
  const head = commit(root, { 'package.json': '{"type":"module","name":"changed-policy"}\n',
    'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const zero = 0;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.ok(plan.units.includes(USER_TEST), 'a global change retains the unsealed importer unit');
  assert.ok(plan.units.includes(CONTRACT), 'the changed front door retains its consumer contract');
  assert.deepEqual(plan.skipped, [], 'global policy changes borrow no seal skip');
  for (const file of JOURNEYS) assert.ok(!plan.units.includes(file), `${file} remains a root journey`);
  assert.doesNotThrow(() => requireSealedSkips(root, plan));
  for (const file of [BASE_TEST, USER_TEST, CONTRACT]) {
    assert.throws(() => requireSealedSkips(root, { ...plan, units: plan.units.filter(unit => unit !== file) }),
      error => error.code === 'TEST_SELECTION_INCOMPLETE' && error.message.includes(file));
  }
});
