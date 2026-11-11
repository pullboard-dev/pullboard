/** A main red is recorded by its test's content, so a main move reuses it and only changed content reruns [C7,#3166]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const MAIN_RED = pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/main/red.js')).href;
const CLI = join(import.meta.dirname, '../../pullboard.js');
const KNOWN_MAIN = pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/known/main.js')).href;
const ENVIRONMENT = pathToFileURL(join(import.meta.dirname, '../../../../packages/sandbox/src/io/environment.js')).href;
const RED = "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('inherited red [G1]', () => assert.equal(1, 2));\n";

/** Write one file under the fixture repo. */
function put(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

/** A repo whose main carries one red test, a counting runner, and a private machine home. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-main-red-content-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'), MAIN_RED_RUNS: join(directory, 'main-runs.log') };
  delete env.NODE_TEST_CONTEXT;
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js', lanes: { core: { owns: ['test/', 'lib/'], specs: ['G'] } } }, null, 2) + '\n');
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The inherited case passes. | gate: test/inherited.test.js\n');
  put(root, 'test/inherited.test.js', RED);
  put(root, 'test/runner.js', [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "if (process.env.MAIN_RED_RUNS) appendFileSync(process.env.MAIN_RED_RUNS, `${process.cwd()}\\n`);",
    "const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  const box = { directory, root, env };
  commit(box, 'chore: main with an inherited red');
  return box;
}

/** Commit everything and return main's new commit. */
function commit(box, subject) {
  runFixtureGit(['add', '-A'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', subject], { cwd: box.root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
}

/** How many times the runner has run, at main or anywhere. */
function runs(box) {
  return existsSync(box.env.MAIN_RED_RUNS) ? readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

/**
 * Compare the red file at main the way submit does (detailed, fresh) or the way a landing does (knownMainAccount on a
 * real red gate run), in a child with the fixture's machine home; return the parsed result.
 */
function compare(box, mode, commitId, publishedId) {
  const driver = join(box.directory, 'driver.mjs');
  writeFileSync(driver, [
    `import { compareMainFailures } from ${JSON.stringify(MAIN_RED)};`,
    `import { refreshMainRedComparisons } from ${JSON.stringify(MAIN_RED)};`,
    `import { knownMainAccount } from ${JSON.stringify(KNOWN_MAIN)};`,
    `import { executionEnvironment } from ${JSON.stringify(ENVIRONMENT)};`,
    "import { spawnSync } from 'node:child_process';",
    'const [root, mode, commit, published] = process.argv.slice(2);',
    "const file = 'test/inherited.test.js';",
    "if (mode === 'submit') console.log(JSON.stringify(await compareMainFailures(root, { tests: [{ file, passed: false }] }, undefined, '', { commit, detailed: true, fresh: true })));",
    "else if (mode === 'refresh') console.log(JSON.stringify(await refreshMainRedComparisons(root, commit, published)));",
    // Submit's real call: pinned to the candidate check's executor and runtime, collecting each measured receipt.
    "else if (mode.startsWith('pinned')) { const environment = executionEnvironment(); const receipts = [];",
    "  const execution = { executor: { kind: 'local' }, environment: mode === 'pinned-other' ? { ...environment, node: '99.0.0' } : environment };",
    "  const result = await compareMainFailures(root, { tests: [{ file, passed: false }] }, undefined, '', { commit, detailed: true, fresh: true, execution, onMeasuredReceipt: id => { receipts.push(id); } });",
    "  console.log(JSON.stringify({ ...result, receipts })); }",
    'else {',
    "  const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });",
    "  const gate = { isGreen: false, output: ran.stdout, stages: [{ status: ran.status, output: ran.stdout }], profile: { format: 'tap' } };",
    '  console.log(JSON.stringify(await knownMainAccount({ batch: { root, base: commit } }, gate)));',
    '}',
  ].join('\n'));
  const result = runFixtureChild(process.execPath, [driver, box.root, mode, commitId, publishedId ?? ''], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context ?? result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

/** Refresh two previously named red files through concurrent comparison requests and retain the per-file cache keys. */
function probeRefresh(box, previous, published) {
  const driver = join(box.directory, 'refresh-probe.mjs');
  writeFileSync(driver, [
    `import { refreshMainRedComparisons } from ${JSON.stringify(MAIN_RED)};`,
    "const [root, previous, published] = process.argv.slice(2);",
    'let active = 0, maximum = 0; const calls = [];',
    'const compared = await refreshMainRedComparisons(root, previous, published, undefined, async (_root, profile, _wait, _output, options) => {',
    '  active += 1; maximum = Math.max(maximum, active);',
    '  await new Promise(resolve => setTimeout(resolve, 25));',
    '  const file = profile.tests[0].file; calls.push({ file, options }); active -= 1;',
    '  return { main: options.commit, files: [{ file, result: "red", failures: [{ file, name: "case for " + file }] }] };',
    '});',
    'console.log(JSON.stringify({ maximum, calls, compared }));',
  ].join('\n'));
  const result = runFixtureChild(process.execPath, [driver, box.root, previous, published], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context ?? result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('clause 1: publishing refreshes each cached named red file concurrently at the new main while keeping per-file cases [C7]', t => {
  const box = fixture(t);
  const previous = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  assert.equal(compare(box, 'submit', previous).files[0].result, 'red');
  const cachePath = join(box.root, '.git', 'pullboard', 'main-red.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const priorOutcome = cache.entries[previous]['test/inherited.test.js'];
  assert.ok(priorOutcome.failures?.length, 'the previous main entry retains named cases');
  cache.entries[previous]['test/second-inherited.test.js'] = { ...priorOutcome,
    failures: priorOutcome.failures.map(row => ({ ...row, file: 'test/second-inherited.test.js', ran: 'test/second-inherited.test.js' })) };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
  put(box.root, 'docs/unrelated.md', 'main moves before publication refresh\n');
  const published = commit(box, 'docs: publish a new main');
  const result = probeRefresh(box, previous, published);
  assert.equal(result.maximum, 2, 'the two runner requests overlap');
  assert.deepEqual(result.calls.map(row => row.file).sort(), ['test/inherited.test.js', 'test/second-inherited.test.js']);
  assert.ok(result.calls.every(row => row.options.commit === published && row.options.detailed === true
    && row.options.fresh === true), JSON.stringify(result.calls));
  assert.deepEqual(Object.keys(cache.entries[previous]).sort(), ['test/inherited.test.js', 'test/second-inherited.test.js']);
});

test('clause 2: a landing after refresh reuses the new per-file named result without another comparison run [C7]', t => {
  const box = fixture(t);
  const previous = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  assert.equal(compare(box, 'submit', previous).files[0].result, 'red');
  put(box.root, 'docs/unrelated.md', 'main moves before the background refresh\n');
  const published = commit(box, 'docs: publish a new main');
  compare(box, 'refresh', previous, published);
  const afterRefresh = runs(box);
  const cachePath = join(box.root, '.git', 'pullboard', 'main-red.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const outcome = cache.entries[published]?.['test/inherited.test.js'];
  assert.equal(outcome?.result, 'red');
  assert.ok(outcome.failures?.some(row => row.name === 'inherited red [G1]'), JSON.stringify(outcome));
  const account = compare(box, 'landing', published);
  assert.deepEqual(account.known?.map(row => [row.file, row.name]), [['test/inherited.test.js', 'inherited red [G1]']]);
  assert.equal(runs(box), afterRefresh, 'the later landing records zero comparison runs after the background refresh');
});

test('clause 1 and clause 3: a red recorded by submit is a landing\'s known-main case at a moved main, with no main rerun [C7,#3166]', t => {
  const box = fixture(t);
  const first = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  const submitted = compare(box, 'submit', first);
  assert.equal(submitted.files[0].result, 'red', JSON.stringify(submitted));
  const measured = runs(box);
  assert.equal(measured, 1, 'submit measured main once');
  put(box.root, 'docs/unrelated.md', 'main moves on with no change to the test or its code\n');
  const moved = commit(box, 'docs: main moves');
  const account = compare(box, 'landing', moved);
  assert.deepEqual(account?.known?.map(row => [row.file, row.name]), [['test/inherited.test.js', 'inherited red [G1]']], JSON.stringify(account));
  assert.deepEqual(account.remaining, [], 'nothing is charged to the landing');
  assert.equal(runs(box), measured, 'main was not rerun for the landing');
  assert.equal(compare(box, 'submit', moved).files[0].result, 'red');
  assert.equal(runs(box), measured, 'a fresh submit comparison reuses the content record too');
});

test('clause 2: a changed test file forces one fresh main rerun, whose result is stored and reused [C7,#3166]', t => {
  const box = fixture(t);
  const base = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  assert.equal(compare(box, 'submit', base).files[0].result, 'red');
  assert.equal(runs(box), 1);
  put(box.root, 'test/inherited.test.js', RED.replace('assert.equal(1, 2)', 'assert.equal(1, 3)'));
  const changed = commit(box, 'test: the red case changes');
  assert.equal(compare(box, 'submit', changed).files[0].result, 'red');
  assert.equal(runs(box), 2, 'new content runs main once');
  put(box.root, 'docs/unrelated.md', 'main moves again\n');
  const moved = commit(box, 'docs: main moves');
  assert.equal(compare(box, 'submit', moved).files[0].result, 'red');
  assert.equal(runs(box), 2, 'the new record survives the next main move');
});

test('clause 3: submit\'s executor-pinned comparisons write and read the content record under their executor and runtime [C7,#3166]', t => {
  const box = fixture(t);
  const first = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  const measured = compare(box, 'pinned', first);
  assert.equal(measured.files[0].result, 'red', JSON.stringify(measured));
  assert.equal(runs(box), 1, 'the pinned comparison measured main once');
  assert.equal(measured.receipts.length, 1, 'its receipt is reported');
  put(box.root, 'docs/unrelated.md', 'main moves with the test and its code unchanged\n');
  const moved = commit(box, 'docs: main moves');
  const reused = compare(box, 'pinned', moved);
  assert.equal(reused.files[0].result, 'red');
  assert.equal(runs(box), 1, 'the same executor and runtime reuse the record after main moves');
  assert.deepEqual(reused.receipts, measured.receipts, 'the reused record names the receipt that measured it');
  assert.equal(compare(box, 'landing', moved)?.known?.length, 1, 'a landing reads the record the pinned run wrote');
  assert.equal(runs(box), 1, 'so main ran once for that content');
  const other = compare(box, 'pinned-other', moved);
  assert.ok(runs(box) > 1 || other.unavailable, 'another runtime never reuses that evidence');
});

test('clause 1: a batch that changed the failing test\'s inputs is compared with a fresh main run, never the content record [C7,#3166]', t => {
  const box = fixture(t);
  const first = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  assert.equal(compare(box, 'submit', first).files[0].result, 'red');
  assert.equal(runs(box), 1);
  put(box.root, 'docs/unrelated.md', 'main moves\n');
  const base = commit(box, 'docs: main moves');
  // The batch's own commit on that base changes the failing test, which stays red with the same case name.
  put(box.root, 'test/inherited.test.js', RED.replace('assert.equal(1, 2)', 'assert.equal(1, 2, "changed by the item")'));
  commit(box, 'test: the item changes the red test');
  compare(box, 'landing', base);
  assert.equal(runs(box), 2, 'the landing reran main for the changed test instead of trusting the content record');
});

test('clause 3: two cold readers of the same content run main once even with free gate slots, the second waiting on the content flight [C7,#3166]', async t => {
  const box = fixture(t);
  const first = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }).trim();
  const driver = join(box.directory, 'cold-driver.mjs');
  writeFileSync(driver, [
    `import { compareMainFailures } from ${JSON.stringify(MAIN_RED)};`,
    "const [root, commit] = process.argv.slice(2);",
    "console.log(JSON.stringify(await compareMainFailures(root, { tests: [{ file: 'test/inherited.test.js', passed: false }] }, undefined, '', { commit, detailed: true, fresh: true })));",
  ].join('\n'));
  const configured = runFixtureChild(process.execPath, [CLI, 'settings', 'gateSlots', '4', '--json'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.context ?? configured.stdout + configured.stderr);
  const env = box.env;
  const child = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [driver, box.root, first], { cwd: box.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.on('error', reject);
    proc.on('close', status => status === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(out + err)));
  });
  const [one, two] = await Promise.all([child(), child()]);
  assert.equal(one.files[0].result, 'red', JSON.stringify(one));
  assert.equal(two.files[0].result, 'red', JSON.stringify(two));
  assert.equal(runs(box), 1, 'main executed the file once for two concurrent cold readers');
});
