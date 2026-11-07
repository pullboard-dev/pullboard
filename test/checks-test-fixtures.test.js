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
  fixtureProblems,
  fixtureSites,
} from '../bin/checks/test-fixtures.js';
import { existsSync } from 'node:fs';
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
  assert.deepEqual(kinds("run(dir, ['join', 'core', '--model', 'claude-x']);"), ['model']);
  assert.deepEqual(kinds("const env = { PULLBOARD_MODEL: 'gpt-x' };"), ['model']);
  assert.deepEqual(kinds("const text = readFileSync(join(import.meta.dirname, '../SPEC.md'), 'utf8');"), ['repo-read']);
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
  assert.deepEqual(kinds("/** @pullboard-world-pin spec */\nreadFileSync(new URL('../SPEC.md', import.meta.url));"), []);
  assert.deepEqual(fixtureSites("mkdtempSync('x');", 'test/kit/repo.js'), []);
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

/** The repository root this test file lives in. */
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('clause 1: the fixture check finds no site past its ceilings in this repository [C7]', () => {
  assert.deepEqual(fixtureProblems(REPO), []);
});

test('clause 2: every helper path the check names exists in the tree and appears in its messages [C7]', () => {
  for (const [kind, path] of Object.entries(FIXTURE_HELPERS)) {
    assert.ok(existsSync(join(REPO, path)), `${kind} names ${path}, which must exist`);
    const message = fixtureSites(kind === 'model' ? "x({ model: 'm' });" : kind === 'raw-cli' ? "box.run(box.repo, 'add', 'web');" : "mkdtempSync('x');", 'test/example.test.js')
      .find(row => row.kind === kind)?.text ?? '';
    assert.ok(message.includes(path), `${kind} message names ${path}`);
  }
});
