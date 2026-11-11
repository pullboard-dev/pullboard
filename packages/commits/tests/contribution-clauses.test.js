/** The clause runner proves each clause kind on real base and head commits and turns down every cheat [CR3]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../apps/cli/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../apps/cli/tests/fixtures/testkit.js';
import { runContributionClauses } from '../index.js';

const ALLOWLIST = ['node scripts/check.js', 'node scripts/size.js'];

/** The base source: add() is wrong, a kept test passes, check.js fails, size.js prints 40. */
const BASE = {
  'package.json': '{ "type": "module" }\n',
  'src/add.js': 'export function add(a, b) { return a - b; }\n',
  'src/greet.js': 'export function greet(name) { return `hi ${name}`; }\n',
  'tests/greet.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\ntest('greets by name', () => { assert.equal(greet('ann'), 'hi ann'); });\n",
  'scripts/check.js': "import { add } from '../src/add.js';\nprocess.exit(add(2, 2) === 4 ? 0 : 1);\n",
  'scripts/size.js': 'console.log(40);\n',
};

/** The head: add() is fixed, sum() is new, tests for each case and its cheats, size.js prints 12. */
const HEAD = {
  'src/add.js': 'export function add(a, b) { return a + b; }\nexport function sum(list) { return list.reduce(add, 0); }\n',
  'scripts/size.js': 'console.log(12);\n',
  'tests/add.test.js': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { add } from '../src/add.js';",
    "test('adds two numbers', () => { assert.equal(add(2, 3), 5); });",
    "test('always true', () => { assert.ok(true); });",
    "test('throws without asserting', () => { if (add(2, 3) !== 5) throw new TypeError('not an assertion'); });",
    '',
  ].join('\n'),
  'tests/sum.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from '../src/add.js';\ntest('sums a list', () => { assert.equal(sum([1, 2, 3]), 6); });\n",
  'tests/empty.test.js': "import { add } from '../src/add.js';\nexport const unused = add;\n",
};

/** A private folder removed when the test ends. */
function owned(t, prefix) {
  const { root, write } = privateFixtureFiles(prefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, write };
}

/** A fresh repository with the base and head commits above, removed when the test ends; `beforeHead` may touch it. */
function fixture(t, extraHead = {}, beforeHead = () => {}) {
  const graph = fixtureCommittedGraph('pullboard-clauses-fixture-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(BASE)) graph.put(path, body);
  const base = graph.commit();
  for (const [path, body] of Object.entries({ ...HEAD, ...extraHead })) graph.put(path, body);
  beforeHead(graph.root);
  const head = graph.commit();
  return { t, root: graph.root, base, head };
}

/** Run a bar of numbered clauses against the fixture in a fresh scratch folder and return the report. */
function clauses(repo, entries, options = {}) {
  const bar = entries.map(([clause], i) => `${i + 1}: ${clause}`);
  const check = entries.map(([, command], i) => `${i + 1}: ${command}`);
  const scratch = owned(repo.t, 'pullboard-clauses-scratch-').root;
  return runContributionClauses({ repo: repo.root, base: repo.base, head: repo.head, bar, check, scratch, allowlist: ALLOWLIST, ...options });
}

test('[CR3] one clause of each kind is proven on real commits: test, test kept, command and measurement', async t => {
  const repo = fixture(t);
  const report = await clauses(repo, [
    ['add returns the sum [test]', 'tests/add.test.js > adds two numbers'],
    ['greet still greets [test, kept]', 'tests/greet.test.js > greets by name'],
    ['the check script passes [command]', 'node scripts/check.js'],
    ['size prints under 20 [measurement]', 'node scripts/size.js'],
  ]);
  assert.deepEqual(report.clauses.map(c => [c.n, c.kind, c.verdict]), [
    ['1', 'test', 'proven'], ['2', 'test, kept', 'proven'], ['3', 'command', 'proven'], ['4', 'measurement', 'proven'],
  ], JSON.stringify(report.clauses, null, 2));
  assert.equal(report.clauses[0].onBase, 'assertion', 'base source plus only the PR tests: head fixed src/add.js, so a head-source run would pass');
  assert.equal(report.clauses[0].onHead, 'pass');
  assert.equal(report.clauses[1].edited, false);
  assert.equal(report.clauses[2].baseStatus, 1);
  assert.equal(report.clauses[2].headStatus, 0);
  assert.equal(report.clauses[3].value, 12);
  assert.equal(report.node, process.version);
  assert.match(report.note, /not that it means what the clause says/u);
});

test('[CR3] a measurement over its threshold and a command that already passes on base both fail', async t => {
  const repo = fixture(t);
  const report = await clauses(repo, [
    ['size prints under 5 [measurement]', 'node scripts/size.js'],
    ['size runs [command]', 'node scripts/size.js'],
  ]);
  assert.equal(report.clauses[0].verdict, 'failed');
  assert.match(report.clauses[0].reason, /measured 12 on head/u);
  assert.equal(report.clauses[1].verdict, 'failed');
  assert.match(report.clauses[1].reason, /exits 0 on base too/u);
});

test('[CR3] none with a reason reports unverified, and a bare none is refused', async t => {
  const repo = fixture(t);
  const report = await clauses(repo, [
    ['the installer works on Windows [command]', 'none: Windows-only proof'],
    ['something else [command]', 'none'],
  ]);
  assert.equal(report.clauses[0].verdict, 'unverified');
  assert.match(report.clauses[0].reason, /Windows-only proof/u);
  assert.equal(report.clauses[1].verdict, 'refused');
  assert.equal(report.clauses[1].refusal.code, 'CLAUSE_NONE_REASON');
});

test('[CR3] the cheats fail: an assert-true test, a load error, zero tests and a non-assertion throw', async t => {
  const repo = fixture(t);
  const report = await clauses(repo, [
    ['assert-true proves nothing [test]', 'tests/add.test.js > always true'],
    ['sum needs a symbol base lacks [test]', 'tests/sum.test.js > sums a list'],
    ['a file with no tests [test]', 'tests/empty.test.js > adds two numbers'],
    ['a test name that does not exist [test]', 'tests/add.test.js > no such test'],
    ['a throw is not an assertion [test]', 'tests/add.test.js > throws without asserting'],
  ]);
  const by = report.clauses.map(c => [c.verdict, c.onBase, c.onHead]);
  assert.deepEqual(by, [
    ['failed', 'pass', null],
    ['failed', 'load-error', null],
    ['failed', 'zero-tests', null],
    ['failed', 'zero-tests', null],
    ['failed', 'error', null],
  ], JSON.stringify(report.clauses, null, 2));
  assert.match(report.clauses[0].reason, /assert-true/u);
  assert.match(report.clauses[1].reason, /missing helper, import or symbol/u);
  assert.match(report.clauses[2].reason, /zero tests/u);
});

test('[CR3] a kept test the PR edits runs as base wrote it and is flagged for review', async t => {
  const repo = fixture(t, { 'src/greet.js': 'export function greet(name) { return `hello ${name}`; }\n',
    'tests/greet.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\ntest('greets by name', () => { assert.equal(greet('ann'), 'hello ann'); });\n" });
  const [kept] = (await clauses(repo, [['greet still greets [test, kept]', 'tests/greet.test.js > greets by name']])).clauses;
  assert.equal(kept.verdict, 'failed', 'base expects "hi ann" and head says "hello ann"');
  assert.equal(kept.edited, true);
  assert.match(kept.review, /goes to review/u);
});

test('[CR3] commands off the allowlist or holding shell syntax are refused before they run', async t => {
  const repo = fixture(t);
  const report = await clauses(repo, [
    ['remove things [command]', 'rm -rf src'],
    ['another node script [command]', 'node src/add.js'],
    ['chain a command [command]', 'node scripts/check.js; touch ran'],
    ['a measurement off the list prints under 3 [measurement]', 'node src/add.js'],
    ['a measurement with no threshold [measurement]', 'node scripts/size.js'],
  ]);
  assert.deepEqual(report.clauses.map(c => [c.verdict, c.refusal?.code]), [
    ['refused', 'CLAUSE_NOT_ALLOWLISTED'], ['refused', 'CLAUSE_NOT_ALLOWLISTED'], ['refused', 'CLAUSE_COMMAND_SYNTAX'],
    ['refused', 'CLAUSE_NOT_ALLOWLISTED'], ['refused', 'CLAUSE_THRESHOLD'],
  ]);
});

test('[CR3] paths outside the repository are refused: absolute, "..", a leading dash and a symlink out', async t => {
  const outside = owned(t, 'pullboard-clauses-outside-');
  outside.write('escape.test.js', "import { test } from 'node:test';\ntest('escapes', () => { throw new Error('ran outside'); });\n");
  const repo = fixture(t, {}, root => symlinkSync(join(outside.root, 'escape.test.js'), join(root, 'tests', 'link.test.js')));
  const report = await clauses(repo, [
    ['absolute path [test]', `${join(outside.root, 'escape.test.js')} > escapes`],
    ['dot-dot path [test]', '../escape.test.js > escapes'],
    ['option as a path [test]', '--eval=1 > escapes'],
    ['symlink out of the repo [test]', 'tests/link.test.js > escapes'],
    ['dot-dot argument [command]', 'node scripts/check.js ../x'],
  ]);
  assert.deepEqual(report.clauses.map(c => c.refusal?.code), ['CLAUSE_PATH', 'CLAUSE_PATH', 'CLAUSE_PATH', 'CLAUSE_PATH', 'CLAUSE_PATH'], JSON.stringify(report.clauses, null, 2));
});

test('[CR3] a command whose script is a symlink out of the repository is refused', async t => {
  const outside = owned(t, 'pullboard-clauses-outside-');
  outside.write('measure.js', 'console.log(1);\n');
  const repo = fixture(t, {}, root => {
    rmSync(join(root, 'scripts', 'size.js'), { force: true });
    symlinkSync(join(outside.root, 'measure.js'), join(root, 'scripts', 'size.js'));
  });
  const report = await clauses(repo, [['size runs [command]', 'node scripts/size.js']]);
  assert.equal(report.clauses[0].refusal?.code, 'CLAUSE_PATH', JSON.stringify(report.clauses, null, 2));
});

test('[CR3] Node is pinned: a runner whose node reports another version is refused before any clause runs', async t => {
  const repo = fixture(t);
  await assert.rejects(clauses(repo, [['add returns the sum [test]', 'tests/add.test.js > adds two numbers']], { node: { version: 'v0.0.1' } }),
    error => error.code === 'CLAUSE_NODE_PIN' && error.message.includes('v0.0.1'));
  const report = await clauses(repo, [['add returns the sum [test]', 'tests/add.test.js > adds two numbers']], { node: { path: process.execPath, version: process.version } });
  assert.equal(report.node, process.version);
  assert.equal(report.clauses[0].verdict, 'proven');
});

test('[CR3] the scratch folder must be empty and outside the repository, so nothing is written anywhere else', async t => {
  const repo = fixture(t);
  const entry = [['add returns the sum [test]', 'tests/add.test.js > adds two numbers']];
  await assert.rejects(clauses(repo, entry, { scratch: repo.root }), error => error.code === 'CLAUSE_SCRATCH');
  const full = owned(t, 'pullboard-clauses-full-');
  full.write('left-over', 'x');
  await assert.rejects(clauses(repo, entry, { scratch: full.root }), error => error.code === 'CLAUSE_SCRATCH');
});
