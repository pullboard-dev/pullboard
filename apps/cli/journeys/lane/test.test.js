/** The fixture scanner flags raw setup and refuses growth past a file ceiling [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FIXTURE_HELPERS,
  compositionBase,
  fixtureProblems,
  fixtureSites,
} from '../../../../packages/gate/src/io/test/fixtures.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fileURLToPath } from 'node:url';

/** The kinds the scanner finds in one source, sorted and de-duplicated. */
function kinds(source) {
  return [...new Set(fixtureSites(source, 'test/example.test.js').map(row => row.kind))].sort();
}

test('clause 1: each pattern is flagged and a clean file is not [C7]', () => {
  assert.deepEqual(kinds("const d = mkdtempSync(join(tmpdir(), 'x'));"), ['tempdir']);
  assert.deepEqual(kinds("git(dir, ['init', '-q']);"), ['tempdir']);
  assert.deepEqual(kinds("run(dir, 'add', 'Title');"), ['raw-cli']);
  assert.deepEqual(kinds("run(dir, 'join', 'core');"), ['raw-cli']);
  assert.deepEqual(kinds("box.run('lane', 'add', 'web', '--owns', 'web/');"), []);
  assert.deepEqual(kinds("fixtureAdd(box.run, box.repo, 'web', 'Title'); fixtureJoin(box.run, dir, 'core');"), []);
  assert.deepEqual(kinds("spawnSync(process.execPath, [...fixtureAddArgv(BIN), 'web', 'Title']);"), []);
  assert.deepEqual(fixtureSites("run(cwd, 'add', ...args);", 'apps/cli/tests/fixtures/testkit.js'), []);
  assert.deepEqual(kinds("run(dir, ['join', 'core', '--model', 'claude-x']);"), ['model']);
  assert.deepEqual(kinds("const env = { PULLBOARD_MODEL: 'gpt-x' };"), ['model']);
  assert.deepEqual(kinds("const text = readFileSync(join(import.meta.dirname, '../../../../SPEC.md'), 'utf8');"), ['repo-read']);
  assert.deepEqual(kinds(`const sha = '${'ab12'.repeat(16)}';`), ['hex64']);
  const clean = [
    "const a = 'mkdtempSync( run(dir, \"add\" --model gpt-x';",
    '// mkdtempSync(x) and run(dir, "join", "core")',
    "const b = readFileSync(join(dir, 'SPEC.md'), 'utf8');",
    "const c = 'a'.repeat(64) + '" + 'a'.repeat(64) + "';",
    "assert.deepEqual(row, { model: 'unknown' });",
    "git(dir, ['add', '-A']);",
    "box.git(dir, 'add', '-A');",
  ].join('\n');
  assert.deepEqual(kinds(clean), []);
  assert.deepEqual(kinds("/** @pullboard-world-pin spec */\nreadFileSync(new URL('../../../../SPEC.md', import.meta.url));"), []);
  assert.deepEqual(fixtureSites("mkdtempSync('x');", 'apps/cli/tests/fixtures/testkit.js'), []);
});

test('clause 2: a test file one over its ceiling is refused [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-ceiling-'));
  try {
    mkdirSync(join(root, 'test'));
    const path = join(root, 'test/a.test.js');
    const ceilings = join(root, 'ceilings.json');
    writeFileSync(path, "run(dir, 'add', 'one');\n");
    writeFileSync(ceilings, JSON.stringify({ 'test/a.test.js': { 'raw-cli': 1 } }));
    assert.deepEqual(fixtureProblems(root, ceilings), []);
    writeFileSync(path, "run(dir, 'add', 'one');\nrun(dir, 'add', 'two');\n");
    const refused = fixtureProblems(root, ceilings);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].path, 'test/a.test.js');
    assert.equal(refused[0].line, 2);
    assert.match(refused[0].text, /^raw-cli:/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clause 1: env-spread, hand-policy and raw-board are each reported with their kind and line, and a clean file reports nothing [C7]', () => {
  const rows = source => fixtureSites(source, 'test/example.test.js').map(row => `${row.kind}:${row.line}`);
  assert.deepEqual(rows("const BIN = 'apps/cli/pullboard.js';\nspawnSync(process.execPath, [BIN], { env: { ...process.env, PULLBOARD_HOME: home } });"), ['env-spread:2']);
  assert.deepEqual(rows("const BIN = 'apps/cli/pullboard.js';\nspawnSync(process.execPath, [BIN], { env: { ...process.env } });"), [], 'no PULLBOARD_ key beside the spread');
  assert.deepEqual(rows("spawnSync('node', ['x.js'], { env: { ...process.env, PULLBOARD_HOME: home } });"), [], 'a file that does not name the CLI entry');
  assert.deepEqual(rows("const a = 1;\nwriteFileSync(join(dir, 'pullboard.json'), '{}');"), ['hand-policy:2']);
  for (const name of ['SPEC.md', 'packages/codemap/data/plan/cells.json', 'settings.json']) assert.deepEqual(rows(`writeFileSync(join(dir, '${name}'), 'x');`), ['hand-policy:1'], name);
  assert.deepEqual(rows("writeFileSync(join(dir, 'a.txt'), 'pullboard.json');"), [], 'the policy name only in the content');
  assert.deepEqual(rows("const x = 1;\nconst board = openBoard(':memory:');"), ['raw-board:2']);
  assert.deepEqual(rows("store.addItem(board, {});\nstore.register(board, {});\nstore.submit(board, 1);"), ['raw-board:1', 'raw-board:2', 'raw-board:3']);
  assert.deepEqual(rows("// fixture-subject: addItem\nconst board = openBoard(':memory:');\nstore.addItem(board, {});"), [], 'a store unit test of addItem itself');
  assert.deepEqual(rows("assert.equal(typeof openBoard(':memory:'), 'object');"), [], 'an assertion argument');
  assert.deepEqual(fixtureSites("writeFileSync(join(dir, 'pullboard.json'), '{}'); openBoard(':memory:');", 'apps/cli/tests/fixtures/testkit.js'), [], 'the kit holds the raw seam');
  assert.deepEqual(rows("const note = 'openBoard( writeFileSync(x, \"pullboard.json\")';\n// store.addItem(board)\nexport const clean = true;"), []);
});

test('clause 2: growth in any of the three new kinds past its ceiling is refused [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-new-kinds-');
  const ceilings = join(fixture.root, 'ceilings.json');
  const one = "const BIN = 'apps/cli/pullboard.js';\nspawnSync(BIN, [], { env: { ...process.env, PULLBOARD_HOME: h } });\nwriteFileSync(join(d, 'pullboard.json'), '{}');\nopenBoard(':memory:');\n";
  fixture.write('test/a.test.js', one);
  fixture.write('ceilings.json', JSON.stringify({ 'test/a.test.js': { 'env-spread': 1, 'hand-policy': 1, 'raw-board': 1 } }));
  assert.deepEqual(fixtureProblems(fixture.root, ceilings, { base: null }), []);
  for (const [kind, extra] of [['env-spread', "spawnSync(BIN, [], { env: { ...process.env, PULLBOARD_X: 1 } });\n"], ['hand-policy', "writeFileSync(join(d, 'settings.json'), '{}');\n"], ['raw-board', "openBoard(':memory:');\n"]]) {
    fixture.write('test/a.test.js', one + extra);
    const refused = fixtureProblems(fixture.root, ceilings, { base: null });
    assert.deepEqual(refused.map(row => row.text.split(':')[0]), [kind], `${kind} growth is refused`);
  }
});

/** The repository root this test file lives in. */
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));

test('clause 1: the fixture check finds no site past its ceilings in this repository [C7]', () => {
  assert.deepEqual(fixtureProblems(REPO), []);
});

test('clause 2: every helper path the check names exists in the tree and appears in its messages [C7]', () => {
  for (const [kind, path] of Object.entries(FIXTURE_HELPERS)) {
    assert.ok(existsSync(join(REPO, path)), `${kind} names ${path}, which must exist`);
    const message = fixtureSites(kind === 'model' ? "x({ model: 'm' });" : kind === 'raw-cli' ? "box.run(box.repo, 'add', 'web');" : kind === 'hand-policy' ? "writeFileSync(join(d, 'pullboard.json'), '{}');" : "mkdtempSync('x');", 'test/example.test.js')
      .find(row => row.kind === kind)?.text ?? '';
    assert.ok(message.includes(path), `${kind} message names ${path}`);
  }
});

/** A private repository with one test file F carrying two raw tempdir rows at its base commit. */
function ratchetFixture() {
  const fixture = privateFixtureFiles('pullboard-ratchet-base-');
  const run = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: fixture.root, encoding: 'utf8' });
  const rows = count => Array.from({ length: count }, (_, at) => `const dir${at} = mkdtempSync(join(tmpdir(), 'x${at}'));`).join('\n') + '\n';
  fixture.write('ceilings.json', '{}\n');
  fixture.write('test/f.test.js', rows(2));
  run('init', '-q', '-b', 'main'); run('add', '.'); run('commit', '-qm', 'base: F carries two inherited rows');
  const base = run('rev-parse', 'HEAD').stdout.trim();
  return { fixture, run, rows, base, ceilings: join(fixture.root, 'ceilings.json') };
}

test('clause 2: only the rows a submission adds are red against its composition base, and the ceilings file is untouched [C7]', () => {
  const { fixture, rows, base, ceilings } = ratchetFixture();
  const before = readFileSync(ceilings, 'utf8');
  const against = () => fixtureProblems(fixture.root, ceilings, { base });
  assert.deepEqual(fixtureProblems(fixture.root, ceilings, { base: null }).map(row => row.line), [1, 2], 'without a base the two inherited rows are red');
  assert.deepEqual(against(), [], 'a submission that leaves F at 2 rows is green');
  fixture.write('test/f.test.js', rows(3));
  const grown = against();
  assert.deepEqual(grown.map(row => `${row.path}:${row.line}`), ['test/f.test.js:3'], 'taking F to 3 is red, naming the added row');
  fixture.write('test/f.test.js', rows(2));
  fixture.write('test/g.test.js', rows(1));
  assert.deepEqual(against().map(row => `${row.path}:${row.line}`), ['test/g.test.js:1'], 'a new file with one row is red');
  fixture.write('test/f.test.js', rows(1));
  fixture.write('test/g.test.js', 'export const clean = true;\n');
  assert.deepEqual(against(), [], 'a submission that removes a row is green');
  assert.equal(readFileSync(ceilings, 'utf8'), before, 'the ceilings file is byte-identical');
});

test('clause 1: the composition base is the second parent of a merge and nothing otherwise [C7]', () => {
  const { fixture, run, rows, base } = ratchetFixture();
  assert.equal(compositionBase(fixture.root), null, 'a plain commit has no composition base');
  run('checkout', '-q', '-b', 'item'); fixture.write('test/h.test.js', 'export const item = true;\n'); run('add', '.'); run('commit', '-qm', 'item work');
  run('checkout', '-q', 'main'); fixture.write('test/f.test.js', rows(2) + 'export const trunk = true;\n'); run('commit', '-qam', 'trunk moves');
  const trunk = run('rev-parse', 'HEAD').stdout.trim();
  run('checkout', '-q', 'item'); run('merge', '-q', '--no-ff', '-m', 'compose', 'main');
  assert.equal(compositionBase(fixture.root), trunk, 'the merged trunk commit is the base');
  assert.notEqual(base, trunk);
  assert.deepEqual(fixtureProblems(fixture.root, join(fixture.root, 'ceilings.json')), [], 'the default base is the composition base, so inherited rows are green');
});
