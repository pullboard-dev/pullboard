/** pullboard mutate seeds each fault in a throwaway copy of a cell and reports caught or missed per fault and per test file [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { runFixtureSetupGit } from './fixtures/child.js';
import { runCliInProcess } from './fixtures/process.js';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const CALC = 'export function add(a, b) {\n  return a + b;\n}\nexport function isAdult(age) {\n  return age >= 18;\n}\n';
const TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { add, isAdult } from './calc.js';",
  "test('add', () => { assert.equal(add(2, 3), 5); });",
  "test('adult', () => { assert.equal(isAdult(30), true); assert.equal(isAdult(3), false); });",
  '',
].join('\n');
const BROKEN = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('never green', () => { assert.equal(1, 2); });\n";

/** A temp git repo whose main holds the cell, and a branch that changed only the isAdult line. */
function fixture() {
  const repo = privateFixtureFiles('mutate-run-').root;
  dirs.push(repo);
  const options = { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } };
  runFixtureSetupGit(['init', '-q', '-b', 'main'], options);
  mkdirSync(join(repo, 'cells', 'calc'), { recursive: true });
  writeFileSync(join(repo, 'cells', 'calc', 'calc.js'), CALC);
  writeFileSync(join(repo, 'cells', 'calc', 'calc.test.js'), TEST);
  writeFileSync(join(repo, 'cells', 'calc', 'broken.test.js'), BROKEN);
  runFixtureSetupGit(['add', '-A'], options);
  runFixtureSetupGit(['commit', '-q', '-m', 'base'], options);
  runFixtureSetupGit(['checkout', '-q', '-b', 'change'], options);
  writeFileSync(join(repo, 'cells', 'calc', 'calc.js'), CALC.replace('age >= 18', 'age >= 21'));
  runFixtureSetupGit(['commit', '-qam', 'change'], options);
  const tmp = privateFixtureFiles('mutate-tmp-').root;
  dirs.push(tmp);
  return { repo, tmp };
}

/** One tree's files and their hashes, so "byte-identical" is a comparison and not a feeling. */
function snapshot(repo) {
  const out = {};
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.name === '.git') continue; const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else out[full] = createHash('sha256').update(readFileSync(full)).digest('hex'); } };
  walk(repo);
  return out;
}

test('clause 1: [C7] mutate seeds the lines changed against main, says caught or missed per fault and per test file, and leaves the tree and temp dir clean', async () => {
  const { repo, tmp } = fixture();
  const before = snapshot(repo);
  const ran = await runCliInProcess(['mutate', 'cells/calc'], { cwd: repo, env: { ...process.env, PULLBOARD_SCRATCH: tmp } });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const out = ran.stdout;
  assert.match(out, /missed {2}cells\/calc\/calc\.js:5 {2}literal {2}return age >= 21;/u, 'the literal fault on the changed line goes uncaught');
  assert.match(out, /caught {2}cells\/calc\/calc\.js:5 {2}comparison .* by calc\.test\.js/u);
  assert.doesNotMatch(out, /calc\.js:2 /u, 'a line the change did not touch gets no fault');
  assert.match(out, /red-before {2}broken\.test\.js/u, 'a test file that fails unmutated is reported and excluded');
  assert.match(out, /test {2}calc\.test\.js {2}caught 1 of 2/u);
  assert.doesNotMatch(out, /test {2}broken\.test\.js/u);
  assert.deepEqual(snapshot(repo), before, 'the working tree is byte-identical after');
  assert.deepEqual(readdirSync(tmp), [], 'the throwaway copy is removed');
});

test('clause 1: [C7] mutate --all seeds every line and --json carries the same rows', async () => {
  const { repo, tmp } = fixture();
  const ran = await runCliInProcess(['mutate', 'cells/calc', '--all', '--json'], { cwd: repo, env: { ...process.env, PULLBOARD_SCRATCH: tmp } });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  assert.equal(report.all, true);
  assert.deepEqual(report.redBefore, ['broken.test.js']);
  assert.ok(report.faults.some((fault) => fault.line === 2 && fault.operator === 'arithmetic' && fault.caught), 'line 2 is seeded under --all and the add test catches it');
  assert.equal(report.caught + report.missed, report.faults.length);
  assert.deepEqual(readdirSync(tmp), []);
});

test('clause 1: [C7] mutate refuses a folder that is not in the checkout, and a cell with no tests', async () => {
  const { repo, tmp } = fixture();
  const env = { ...process.env, PULLBOARD_SCRATCH: tmp };
  const missing = await runCliInProcess(['mutate', 'cells/nope'], { cwd: repo, env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\[NO_CELL\]/u);
  mkdirSync(join(repo, 'cells', 'bare'));
  const bare = await runCliInProcess(['mutate', 'cells/bare'], { cwd: repo, env });
  assert.match(bare.stderr, /\[NO_TESTS\]/u);
});
