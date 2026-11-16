/** pullboard mutate seeds each fault in a throwaway copy of a cell and reports caught or missed per fault and per test file [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { watch } from 'node:fs';
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

let importRun = null;

/** One mutate run over a cell that imports a sibling folder, shared by the three #8099 clause tests so the copy is made once. */
function runImporting() {
  importRun ??= (async () => {
    const repo = privateFixtureFiles('mutate-import-').root;
    const tmp = privateFixtureFiles('mutate-import-tmp-').root;
    dirs.push(repo, tmp);
    const options = { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } };
    runFixtureSetupGit(['init', '-q', '-b', 'main'], options);
    mkdirSync(join(repo, 'kernel'), { recursive: true });
    mkdirSync(join(repo, 'pkg/src'), { recursive: true });
    writeFileSync(join(repo, 'kernel', 'light.js'), 'export const LIMIT = 10;\n');
    writeFileSync(join(repo, 'pkg/src/judge.js'), "import { LIMIT } from '../../kernel/light.js';\nexport const judge = (n) => n < LIMIT;\n");
    writeFileSync(join(repo, 'pkg', 'judge.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { judge } from './src/judge.js';\ntest('judge', () => { assert.equal(judge(3), true); assert.equal(judge(30), false); });\n");
    runFixtureSetupGit(['add', '-A'], options);
    runFixtureSetupGit(['commit', '-q', '-m', 'base'], options);
    const before = snapshot(repo);
    const ran = await runCliInProcess(['mutate', 'pkg', '--all', '--json'], { cwd: repo, env: { ...process.env, PULLBOARD_SCRATCH: tmp } });
    return { ran, before, after: snapshot(repo), left: readdirSync(tmp) };
  })();
  return importRun;
}

test('clause 1: [C7,#8099] a cell importing a sibling folder runs every test green in the copy, none dropped as red-before', async () => {
  const { ran } = await runImporting();
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  assert.deepEqual(report.redBefore, []);
  assert.deepEqual(report.tests.map((row) => row.file), ['judge.test.js']);
});

test('clause 2: [C7,#8099] a seeded fault in the judge that flips its result is caught by the cell tests', async () => {
  const { ran } = await runImporting();
  const report = JSON.parse(ran.stdout);
  assert.ok(report.faults.some((fault) => fault.file === 'src/judge.js' && fault.caught));
});

test('clause 3: [C7,#8099] the checkout working tree is unchanged and the copy removed after a mutate run', async () => {
  const { before, after, left } = await runImporting();
  assert.deepEqual(after, before);
  assert.deepEqual(left, []);
});

/** A cell whose one test starts a grandchild that sleeps for a minute, writes its pid, then passes or hangs; the pid file says who to look for. */
function leakyFixture(hang) {
  const repo = privateFixtureFiles('mutate-reap-').root;
  const tmp = privateFixtureFiles('mutate-reap-tmp-').root;
  dirs.push(repo, tmp);
  const options = { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } };
  const pidFile = join(tmp, 'pids.txt');
  runFixtureSetupGit(['init', '-q', '-b', 'main'], options);
  mkdirSync(join(repo, 'cells', 'leak'), { recursive: true });
  writeFileSync(join(repo, 'cells', 'leak', 'leak.js'), 'export const one = () => 1;\n');
  writeFileSync(join(repo, 'cells', 'leak', 'leak.test.js'), [
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import './leak.js';",
    `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });`,
    `appendFileSync(${JSON.stringify(pidFile)}, child.pid + '\\n');`,
    'child.unref();',
    hang ? "test('hangs', () => new Promise(() => setInterval(() => {}, 1000)));" : "test('passes', () => {});",
    '',
  ].join('\n'));
  runFixtureSetupGit(['add', '-A'], options);
  runFixtureSetupGit(['commit', '-q', '-m', 'base'], options);
  return { repo, tmp, pidFile };
}

/** The pids a fixture test wrote down, read once the file exists. */
function pidsIn(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
}

/** Resolve when the fixture test has written its pid, on the folder's own change event. */
function pidWritten(folder, file) {
  return new Promise((resolve) => {
    const watcher = watch(folder, () => { if (pidsIn(file).length) { watcher.close(); resolve(); } });
    if (pidsIn(file).length) { watcher.close(); resolve(); }
  });
}

/** Let the kernel finish reaping killed processes: yield to the event loop until none is listed alive, for at most five seconds. */
async function allGone(pids) {
  const limit = Date.now() + 5_000;
  while (pids.some(alive) && Date.now() < limit) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether a process is still alive. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('clause 1: [C7,#8500] a finished mutate run leaves no test child or grandchild alive', async () => {
  const { repo, tmp, pidFile } = leakyFixture(false);
  const ran = await runCliInProcess(['mutate', 'cells/leak', '--all'], { cwd: repo, env: { ...process.env, PULLBOARD_SCRATCH: tmp } });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const pids = pidsIn(pidFile);
  assert.ok(pids.length > 0, 'the fixture test started a grandchild');
  await allGone(pids);
  assert.deepEqual(pids.filter(alive), [], 'every grandchild the tests started is gone');
});

test('clause 2: [C7,#8500] a stopped mutate run leaves no test child or grandchild alive', async () => {
  const { repo, tmp, pidFile } = leakyFixture(true);
  const running = runCliInProcess(['mutate', 'cells/leak', '--all'], { cwd: repo, env: { ...process.env, PULLBOARD_SCRATCH: tmp } });
  await pidWritten(tmp, pidFile);
  const pids = pidsIn(pidFile);
  assert.ok(pids.length > 0, 'the fixture test started a grandchild before the stop');
  assert.ok(pids.every(alive), 'the grandchild is running at the stop');
  process.emit('SIGTERM');
  const ran = await running;
  assert.match(ran.stderr, /\[STOPPED\]/u);
  await allGone(pids);
  assert.deepEqual(pids.filter(alive), [], 'the test process and its grandchild are gone');
});
