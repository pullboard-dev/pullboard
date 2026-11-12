/**
 * The person's quality rules that run tests or read the doctrine (D1, D3): a guard its tests pass
 * without, a fix with no control, a new check with no test, a change past its size budget, and the
 * rules drafted as Doctrine rows that stay switched off until the person approves them. Every
 * repo is real git and every test run is a real `node --test`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import { doctrineReport } from '../../../../packages/doctrine/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  QUALITY_RULES,
  breachLine,
  changeRange,
  qualityBreaches,
} from '../../../../packages/rigor/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-rigor-quality-test-')));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Git in a fixture, with a fixed identity, no hooks and none of the suite's GIT_* settings. */
function gitIn(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Write files under a root and commit them with this subject; returns the commit id. */
function commitIn(root, subject, changes) {
  for (const [path, text] of Object.entries(changes)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', subject);
  return gitIn(root, 'rev-parse', 'HEAD');
}

/** A repo on main with `files`, then a work branch; returns its root. */
function repo(name, files) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  gitIn(root, 'init', '-q', '-b', 'main');
  commitIn(root, 'feat: start', files);
  gitIn(root, 'checkout', '-q', '-b', 'work');
  return root;
}

const SIZE = 'export function size(value) {\n  return value.length;\n}\n';
const SIZE_TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { size } from '../src/size.mjs';\ntest('size [G1]', () => assert.equal(size('abc'), 3));\n";

test('rigor names a guard its tests pass without [D1,D3]', () => {
  const root = repo('guard', { 'src/size.mjs': SIZE, 'test/size.test.mjs': SIZE_TEST });
  commitIn(root, 'feat(size): refuse what it cannot count', {
    'src/size.mjs': [
      'export function size(value) {',
      "  if (typeof value !== 'string') throw new TypeError('size counts text');",
      "  if (value.length > 10) throw new RangeError('size counts ten characters at most');",
      '  return value.length;',
      '}',
      '',
    ].join('\n'),
    'test/size.test.mjs': `${SIZE_TEST}test('size refuses a number [G1]', () => assert.throws(() => size(1), TypeError));\n`,
  });
  const breaches = qualityBreaches(root, changeRange(root), { rules: ['guard-mutation'] });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)),
    ['src/size.mjs:3: guard-mutation: adds a guard the change\'s tests still pass without: test/size.test.mjs'],
    'the tested guard fails its test when removed; the untested one is named at its line');
  const untested = repo('guard-untested', { 'src/size.mjs': SIZE, 'test/size.test.mjs': SIZE_TEST });
  commitIn(untested, 'feat(size): refuse a number', { 'src/size.mjs': "export function size(value) {\n  if (typeof value !== 'string') throw new TypeError('size counts text');\n  return value.length;\n}\n" });
  assert.deepEqual(qualityBreaches(untested, changeRange(untested), { rules: ['guard-mutation'] }).map((breach) => breachLine(breach)),
    ['src/size.mjs:2: guard-mutation: adds a guard, and this change touches no test that could fail without it']);
});

test('rigor proves a fix by a control that fails before it and passes after [D1,D3]', () => {
  const broken = 'export function size(value) {\n  return value.length;\n}\n';
  const fixed = 'export function size(value) {\n  return value === null ? 0 : value.length;\n}\n';
  const proven = repo('control-proven', { 'src/size.mjs': broken, 'test/size.test.mjs': SIZE_TEST });
  commitIn(proven, 'fix(size): count null as empty', { 'src/size.mjs': fixed,
    'test/size.test.mjs': `${SIZE_TEST}test('size of null is 0 [G1]', () => assert.equal(size(null), 0));\n` });
  assert.deepEqual(qualityBreaches(proven, changeRange(proven), { rules: ['root-cause-control', 'fix-test'] }), [],
    'the new test fails on the parent and passes at the fix');
  const idle = repo('control-idle', { 'src/size.mjs': broken, 'test/size.test.mjs': SIZE_TEST });
  const fix = commitIn(idle, 'fix(size): count null as empty', { 'src/size.mjs': fixed,
    'test/size.test.mjs': `${SIZE_TEST}test('size of text [G1]', () => assert.equal(size('ab'), 2));\n` });
  assert.deepEqual(qualityBreaches(idle, changeRange(idle), { rules: ['root-cause-control'] }).map((breach) => breachLine(breach)),
    [`test/size.test.mjs:5: root-cause-control: fix ${fix.slice(0, 12)}'s tests pass on its parent too, so they prove no root cause`],
    'a test that passes before the fix proves nothing about its cause');
});

test('rigor names a new check with no test and a change past its size budget [D1,D3]', () => {
  const long = `${Array.from({ length: 1495 }, (_, index) => `export const line${index} = ${index};`).join('\n')}\n`;
  const root = repo('size', { 'src/long.js': long, 'test/long.test.js': '// [G1]\n' });
  commitIn(root, 'feat(checks): count todo markers', {
    'src/long.js': `${long}${Array.from({ length: 10 }, (_, index) => `export const more${index} = ${index};`).join('\n')}\n`,
    'bin/checks/todo.js': 'export const todo = 1;\n',
    'bin/checks/named.js': 'export const named = 1;\n',
    'test/named.test.js': "import '../bin/checks/named.js';\n",
  });
  const breaches = qualityBreaches(root, changeRange(root), { rules: ['fails-closed', 'size-budget'], budget: 5 });
  assert.deepEqual(breaches.map((breach) => breachLine(breach)), [
    'bin/checks/todo.js:1: fails-closed: is a new gate or check, and no test in this change runs it with no data to show it fails closed',
    'src/long.js:1496: size-budget: this change grows code by 12 lines, past its 5-line budget; split the change',
    'src/long.js:1501: size-budget: is 1505 lines, over the 1500-line cap, and this change grows it by 10; split it into a new module',
  ], 'the untested check, the budget at the file that grew most, and the grown over-cap file');
  assert.deepEqual(qualityBreaches(root, changeRange(root), { rules: ['size-budget'] }).map((breach) => breach.line), [1501], 'within the default budget only the cap is named');
  assert.throws(() => qualityBreaches(root, changeRange(root), { rules: ['tabs'] }), (error) => error.code === 'RIGOR_RULE');
});

test('quality rules are drafted for the person and stay off until approved [D1,D3]', async () => {
  const box = e2e.project('true');
  const run = (await box.runLocal(box.repo, 'rigor', '--draft-quality', '--json'));
  assert.equal(run.code, 0, run.out + run.err);
  const drafts = JSON.parse(run.out).qualityDrafts;
  assert.equal(drafts.length, QUALITY_RULES.length, 'one draft per rule');
  const doctrine = loadDoctrine(box.repo);
  for (const rule of QUALITY_RULES) {
    const row = doctrine.repo.rows.find((entry) => entry.source === `rigor-quality:${rule.key}`);
    assert.ok(row, `${rule.key} is drafted`);
    assert.equal(row.status, 'draft', 'only the person approves a rule');
    assert.equal(row.gate, `check pullboard rigor quality --rule ${rule.key}`);
    assert.equal(row.count, '0');
    assert.ok(row.text.startsWith(rule.text) && row.text.includes(rule.how), 'the row says what the check reads and what is left to review');
  }
  assert.deepEqual(doctrineReport(box.repo, loadConfig(box.repo)).filter((rule) => drafts.some((draft) => draft.id === rule.id)), [],
    'no drafted rule runs before the person approves it');
  const again = (await box.runLocal(box.repo, 'rigor', '--draft-quality', '--json'));
  assert.equal(again.code, 0, again.out + again.err);
  assert.deepEqual(JSON.parse(again.out).qualityDrafts, [], 'a rerun drafts nothing twice');
  const lane = (await box.runLocal(box.web, 'rigor', '--draft-quality'));
  assert.equal(lane.code, 1, lane.out + lane.err);
  assert.match(lane.out + lane.err, /COORDINATOR_ONLY/u);
  gitIn(box.repo, 'add', '-A');
  gitIn(box.repo, 'commit', '-q', '-m', 'docs(doctrine): draft the quality rules');
  gitIn(box.web, 'merge', '-q', '--ff-only', 'main');
  const fix = commitIn(box.web, 'fix(web): close the page', { 'web/page.js': 'export const page = 1;\n' });
  const report = (await box.runLocal(box.web, 'rigor', 'quality', '--rule', 'fix-test'));
  assert.equal(report.code, 1, report.out + report.err);
  const row = drafts.find((draft) => draft.row.text.startsWith(QUALITY_RULES[0].text)).id;
  assert.equal(report.out.trim(), `web/page.js:1: ${row} fix-test: fix ${fix.slice(0, 12)} "fix(web): close the page" changes no test that reproduces its failure`,
    'the breach names its file, line, doctrine row and rule');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify({ ...config, rigor: { budget: 0 } }));
  const sizeRow = drafts.find((draft) => draft.row.text.startsWith(QUALITY_RULES[4].text)).id;
  const budget = (await box.runLocal(box.web, 'rigor', 'quality', '--rule', 'size-budget'));
  assert.equal(budget.code, 1, budget.out + budget.err);
  assert.equal(budget.out.trim(), `web/page.js:1: ${sizeRow} size-budget: this change grows code by 1 lines, past its 0-line budget; split the change`,
    'the board\'s committed rigor.budget setting replaces the default');
  assert.equal((await box.runLocal(box.web, 'rigor', 'quality', '--rule', 'size-budget', '--budget', '5')).code, 0, '--budget wins over the setting');
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify({ ...config, rigor: { budget: -1 } }));
  assert.match((await box.runLocal(box.web, 'rigor', 'quality')).err, /BAD_CONFIG/u);
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify(config, null, 2));
  const clean = (await box.runLocal(box.repo, 'rigor', 'quality'));
  assert.equal(clean.code, 0, clean.out + clean.err);
  // Next steps never suggest --wait (0d3ce1cd90, #2905).
  assert.match(clean.out, /(?:^|\n)next: pullboard next\n$/u);
  assert.equal(clean.out.replace(/next: pullboard next\n$/u, '').trim(), '', 'main against itself has no change to judge');
});
