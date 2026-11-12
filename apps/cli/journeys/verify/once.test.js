/** An item proves once: review cites sealed verdicts, landing adds only composition and journeys (RFC 0006 A4, A5) [C7,CD44]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  citedReceipts,
  citedReceiptsNote,
  landingRunFiles,
  recordSeal,
  reviewCitations,
  sealStatus,
  sealStoreFile,
  selectTestTiers,
  writeTestTiers,
} from '../../../../packages/gate/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { main } from '../../tests/fixtures/native.js';
import { openBoard } from '../../../lib/index.js';
import { closeBoard } from '../../../../packages/store/index.js';


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


test('control: deleting a required unit without declaring any skip cannot hide a real change [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => a - b;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  const hidden = { ...plan, units: plan.units.filter(file => file !== BASE_TEST), skipped: [] };
  assert.throws(() => reviewCitations(root, hidden), { code: 'TEST_SELECTION_INCOMPLETE', message: /base\.test\.js/u });
});


test('native review records sealed citations and reuses the actual submit execution [C7,CD44]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  const baseRuns = join(box.dir, 'base-runs'), aloneRuns = join(box.dir, 'alone-runs');
  const config = { ...helpers.CONFIG, gate: 'true', affectedTests: 'node --test',
    lanes: { web: { owns: ['packages/base/'], specs: ['G1'] }, api: { owns: ['packages/alone/'], specs: ['G2'] } } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  for (const [name, marker] of [['base', baseRuns], ['alone', aloneRuns]]) {
    mkdirSync(join(box.repo, 'packages', name, 'tests'), { recursive: true });
    writeFileSync(join(box.repo, 'packages', name, 'index.js'), 'export const value = 1;\n');
    writeFileSync(join(box.repo, 'packages', name, 'tests/value.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { appendFileSync } from 'node:fs';\n"
      + "import { value } from '../index.js';\n"
      + `test('the fixture value is positive [G1]', () => { assert.ok(value > 0); ${name === 'base' ? 'if (value === 2) ' : ''}appendFileSync(${JSON.stringify(marker)}, 'x'); });\n`);
  }
  writeTestTiers(box.repo);
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-qm', 'chore: private sealed packages');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  // Seed only this private seal store; the assertion below checks the actual native verdict and executions.
  const sealFile = sealStoreFile(box.repo);
  for (const row of sealStatus(box.repo)) recordSeal(sealFile, { package: row.package, hash: row.hash, receipts: [`seed-${row.package.split('/').at(-1)}`], tests: [] });
  /** Invoke the real native CLI while keeping private fixture identity and output serialized. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const added = await cli(box.repo, 'add', 'web', 'Prove the changed base once', '--specs', 'G1',
    '--criterion', 'The base value remains positive.', '--check', 'node --test packages/base/tests/value.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(existsSync(baseRuns), false, 'the baseline value does not count as candidate execution');
  const claimed = await cli(box.web, 'claim', String(id)); assert.equal(claimed.code, 0, claimed.err);
  writeFileSync(join(box.web, 'packages/base/index.js'), 'export const value = 2;\n');
  box.git(box.web, 'add', '-A'); box.git(box.web, 'commit', '-qm', 'feat(web): change private base [G1]');
  const submitted = await cli(box.web, 'submit', String(id), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const count = readFileSync(baseRuns, 'utf8');
  assert.equal(count, 'x', 'submit executes the actual candidate test exactly once');
  assert.equal(existsSync(aloneRuns), false, 'the unchanged sealed package did not execute');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  const joined = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  const reviewed = await cli(reviewer, 'verify', String(id), 'accept', '--no-next',
    '--note', 'Read the frozen positive-value change and its native proof.', '--json');
  assert.equal(reviewed.code, 0, reviewed.err + reviewed.out);
  assert.equal(readFileSync(baseRuns, 'utf8'), count, 'review adds no second execution to the proven item: ' + reviewed.out + reviewed.err);
  assert.equal(existsSync(aloneRuns), false, 'review cites the sealed package without executing it');
  // @pullboard-board-file journey: read the board file the real review command wrote
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const verdict = board.db.prepare('SELECT verdict_note FROM verdict WHERE item_id=? ORDER BY verdict_id DESC LIMIT 1').get(id);
    assert.deepEqual(citedReceipts(verdict.verdict_note).map(row => [row.package, row.receipt]), [['packages/alone', 'seed-alone']]);
    assert.match(verdict.verdict_note, /reused submit proof/u, 'the persisted verdict also cites native submission proof');
  } finally { closeBoard(board); }
});
