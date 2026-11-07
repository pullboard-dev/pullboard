/** @pullboard-test-input source-tree */
/** @pullboard-world-pin copies the shipped wall-clock budgets helper into the private installed copy the runners package is imported from. */
/** Ordinary runner loading stays light; full gates and truthful repository selection retain their inputs [C7,V4]. */
import { executionServicesSource } from './gate-execution-fixture.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { privateFixtureFiles, runFixtureChild } from './fixture-child.js';
import { selectAffectedTests } from '../packages/gate/index.js';
import { testClosures } from '../packages/gate/index.js';
import { importsIn } from '../packages/gate/index.js';
import { copyPackageFiles, toolSourcePath } from '../packages/runners/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = join(ROOT, 'bin/run-tests.js');
const HEAVY = ['packages/gate/src/shell/gate.js', 'src/board.js', 'src/machine.js'];

/** Observe each process where Node preloads this observer; PID records distinguish the controller from file workers. */
function moduleObserver(box) {
  const trace = join(box.dir, 'loaded.jsonl');
  const hook = join(box.dir, 'observe-loader.mjs');
  const probe = join(box.dir, 'observe.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    'let trace;',
    'export function initialize(data) { trace = data.trace; }',
    "export async function load(url, context, nextLoad) { const result = await nextLoad(url, context); appendFileSync(trace, JSON.stringify({pid:process.pid,url}) + '\\n'); return result; }",
  ].join('\n'));
  writeFileSync(probe, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hook).href)}, { data: { trace: ${JSON.stringify(trace)} } });\n`);
  return { probe, trace };
}

/** Use ordinary native admission against a private Git/SQLite board and private machine; the test supplies no live marker. */
function fixture({ currentReleaseFirst = false } = {}) {
  const box = helpers.project('node --test --test-reporter=tap web/plain.test.js');
  delete box.env.NODE_TEST_CONTEXT;
  if (currentReleaseFirst) {
    mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gate: { queue: { currentReleaseFirst: true } } }));
  }
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  box.ran = join(box.dir, 'plain-ran');
  box.ranPid = join(box.dir, 'plain-worker-pid');
  writeFileSync(join(box.repo, 'web/plain.test.js'), [
    "import { test } from 'node:test'; import { writeFileSync } from 'node:fs';",
    `test('plain worker really executes', () => { writeFileSync(${JSON.stringify(box.ran)}, 'executed'); writeFileSync(${JSON.stringify(box.ranPid)}, String(process.pid)); });`,
  ].join('\n'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: prepare lazy runner fixture [G1]');
  return { ...box, ...moduleObserver(box) };
}

/** Require a successful actual child before interpreting its append-only module list. */
function observed(box, args) {
  const child = runFixtureChild(process.execPath, ['--import', box.probe, ...args], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.context ?? child.stderr + child.stdout);
  const records = readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { child, records, urls: records.map(record => record.url) };
}

/** Read declarations throughout the leading comment header, never from executable code or quoted examples. */
function sourceTreeReader(source) {
  const header = source.match(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u)[0];
  return header.split(/\r?\n/u).some(line => line.trim() === '/** @pullboard-test-input source-tree */');
}

/** Independently trace historical literal importer paths without assuming their cache completeness. */
function knownLiteralBoardImporters(closures, modules) {
  const runners = [...modules.keys()].filter(file => /^test\/runners-.*\.test\.js$/u.test(file));
  assert.ok(runners.length > 0, 'the split runner scenarios remain actual importer roots');
  const roots = ['test/run-tests-kill.test.js', 'test/run-tests-timeout.test.js', ...runners];
  const releaseSource = modules.get('packages/landing/src/shell/release-queue.js');
  const releaseImports = importsIn([releaseSource])[0];
  assert.ok(!releaseImports.includes('../../../store/index.js'), 'release capture avoids the eager store front door');
  for (const reader of ['../../../store/src/shell/board-event-log.js', '../../../store/src/shell/board-query.js', '../../../store/src/core/board-milestones-read.js']) {
    assert.ok(releaseSource.includes(`load('${reader}')`), `release capture loads its lazy read-only store module ${reader}`);
  }
  for (const name of ['openBoardReadOnly', 'boardId', 'listItems', 'milestones']) assert.match(releaseSource, new RegExp(`\\b${name}\\b`), `release capture uses canonical reader ${name}`);
  assert.ok(!releaseImports.includes('../../../../src/board.js'), 'release capture does not import the writer facade');
  const parsed = new Map();
  const known = new Set();
  for (const root of roots) {
    const pending = [root], seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      if (file === 'src/board.js') { known.add(root); break; }
      if (!modules.has(file)) continue;
      if (!parsed.has(file)) parsed.set(file, importsIn([modules.get(file)])[0]);
      for (const edge of parsed.get(file)) {
        if (edge.startsWith('.')) pending.push(posix.normalize(posix.join(posix.dirname(file), edge)));
      }
    }
  }
  for (const root of known) {
    const closure = closures.get(root);
    if (closure.files !== null) assert.ok(closure.files.includes('src/board.js'), `${root} complete closure retains its independently proved literal board dependency`);
  }
  return known;
}

test('a plain test run loads no gate board or machine modules through its runner [C7,V4]', { timeout: 90_000 }, // budget: one real private admission and test-file child; hang ceiling only.
() => {
  const box = fixture();
  const { child, urls } = observed(box, [RUNNER, '--test-reporter=tap', 'web/plain.test.js']);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /# pass 1\b/u);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the actual candidate runner was observed');
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'packages/gate/src/shell/gate-slot.js')).href), 'ordinary admission actually ran');
  for (const file of HEAVY) assert.ok(!urls.includes(pathToFileURL(join(ROOT, file)).href), `${file} must remain lazy in an ordinary run`);
});

test('a plain run retains lazy modules with current-release-first queue policy enabled [C7,V4]', { timeout: 90_000 }, // budget: one actual private policy-enabled admission and child; hang ceiling only.
() => {
  const box = fixture({ currentReleaseFirst: true });
  const { child, urls } = observed(box, [RUNNER, '--test-reporter=tap', 'web/plain.test.js']);
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gate.queue.currentReleaseFirst, true);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /# pass 1\b/u);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the actual candidate runner was observed');
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'packages/gate/src/shell/gate-slot.js')).href), 'ordinary policy-enabled admission actually ran');
  for (const file of HEAVY) assert.ok(!urls.includes(pathToFileURL(join(ROOT, file)).href), `${file} must remain lazy with currentReleaseFirst on`);
});

test('the actual test-file preload loads no gate board or machine modules [C7,V4]', { timeout: 90_000 }, // budget: one private Node test-file process with ordinary preload and watchdog; hang ceiling only.
() => {
  const box = fixture();
  // observed() installs the observer first; Node propagates both ordered public --import flags to its test worker.
  const { child, records } = observed(box, ['--test', '--test-reporter=tap', '--import', RUNNER, 'web/plain.test.js']);
  assert.match(child.stdout, /# pass 1\b/u);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  const pid = Number(readFileSync(box.ranPid, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the actual test body recorded its worker PID');
  const urls = records.filter(record => record.pid === pid).map(record => record.url);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the same executed worker was observed loading the candidate preload');
  for (const file of HEAVY) assert.ok(!urls.includes(pathToFileURL(join(ROOT, file)).href), `${file} was not loaded by that actual test-file worker`);
});

test('the full gate still loads its proof modules and executes its configured check [C7,V4]', { timeout: 90_000 }, // budget: one real private full gate; no performance assertion.
() => {
  const box = fixture();
  const gate = pathToFileURL(join(ROOT, 'packages/gate/index.js')).href;
  const source = `const { runGate } = await import(${JSON.stringify(gate)});
${executionServicesSource(gate)} const result = await runGate(process.cwd(), {gate:'node --test --test-reporter=tap web/plain.test.js'}, { executionServices,trustStamp:false}); if (!result.isGreen) throw new Error(result.output); console.log('FULL_GATE_EXECUTED');`;
  const { child, urls } = observed(box, ['--input-type=module', '-e', source]);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /FULL_GATE_EXECUTED/u);
  for (const file of HEAVY) assert.ok(urls.includes(pathToFileURL(join(ROOT, file)).href), `a real full gate retains ${file}`);
});

test('a board change selects its real importers in the actual committed repository [C7,V4]', { timeout: 120_000 }, // budget: complete actual committed import graph; correctness only, no benchmark.
() => {
  // Keep every committed module, including the runner's arbitrary reporter declaration; no synthetic shortened graph.
  const selection = selectAffectedTests(ROOT, { base: 'HEAD', commit: 'HEAD', changed: ['src/board.js'] });
  assert.equal(selection.full, false, selection.reason);
  assert.ok(selection.files.includes('test/board.test.js'), 'the board contract is an actual importer');
  const { closures, modules } = testClosures(ROOT, 'HEAD');
  const known = knownLiteralBoardImporters(closures, modules);
  for (const [file, closure] of closures) {
    if (closure.files !== null) continue;
    assert.ok(selection.files.includes(file), `unknown root ${file} remains conservatively selected`);
    assert.ok(closure.reason, `unknown root ${file} has a nonempty reason`);
    assert.ok(selection.reason.includes(file), `selection discloses unknown root ${file}`);
    assert.ok(selection.reason.includes(closure.reason), `selection discloses the reason for ${file}`);
  }
  const expected = [...closures].filter(([file, closure]) => closure.files === null || closure.files.includes('src/board.js')
    || sourceTreeReader(modules.get(file)) || known.has(file)).map(([file]) => file).sort();
  assert.deepEqual(selection.files, expected, 'exact selection retains actual board importers, declared readers and disclosed conservative unknown roots');
  assert.ok(selection.files.length < closures.size, 'unrelated tests do not become board dependencies through the runner');
});


/** Count every process and worker thread a child starts, from a preload that wraps the real builtins. */
const SPAWN_COUNTER = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const threads = require('node:worker_threads');
globalThis.__spawned = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const original = cp[name];
  cp[name] = function (...args) { globalThis.__spawned.push(name + ' ' + String(args[0])); return original.apply(this, args); };
}
const Worker = threads.Worker;
threads.Worker = class extends Worker { constructor(...args) { globalThis.__spawned.push('worker ' + String(args[0])); super(...args); } };
syncBuiltinESMExports();
`;

test('importing the runners package spawns nothing and pins no tooling; the first runner operation pins it and later changes are refused [C7,P3]', { timeout: 120_000 }, t => { // budget: one private installed copy and one child that pins real tooling; hang ceiling only.
  const directory = privateFixtureFiles('pullboard-lazy-runner-pin-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installed = join(directory, 'installed');
  copyPackageFiles(ROOT, installed);
  mkdirSync(join(installed, 'test'), { recursive: true });
  copyFileSync(join(ROOT, 'test/wall-clock-budgets.js'), join(installed, 'test/wall-clock-budgets.js'));
  const counter = join(directory, 'counter.mjs');
  writeFileSync(counter, SPAWN_COUNTER);
  const url = file => JSON.stringify(pathToFileURL(join(installed, file)).href);
  const script = `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const runners = await import(${url('packages/runners/index.js')});
assert.deepEqual(globalThis.__spawned, [], 'importing the runners package starts no process or worker');
assert.throws(() => runners.loadedToolingFiles({ rescan: false }), error => error.code === 'RUNNER_TOOLING_CHANGED', 'import pins no tooling generation');
// A front-door runner operation pins first; this one then fails on its invalid runner without any SSH.
await runners.probeRunnerJob({ host: '' }, {}).catch(() => {});
assert.ok(globalThis.__spawned.some(entry => entry.startsWith('spawn ')), 'the first runner operation captures the tooling');
assert.ok(runners.loadedToolingFiles({ rescan: false }).files, 'the pinned generation matches the unchanged tooling');
appendFileSync(${JSON.stringify(toolSourcePath(installed, 'packages/runners/src/shell/runner-dispatch.js'))}, '\\n// changed after the first dispatch\\n');
assert.throws(() => runners.loadedToolingFiles({ rescan: false }), error => error.code === 'RUNNER_TOOLING_CHANGED', 'later changed tooling is refused');
`;
  const result = runFixtureChild(process.execPath, ['--import', pathToFileURL(counter).href, '--input-type=module', '-e', script], { cwd: installed, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context ?? result.stderr);
});

test('clause 1: importing the runners package spawns nothing and pins no tooling [C7]', () => {
  const script = [
    "import cp from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'let spawned = 0;',
    "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) { const original = cp[name]; cp[name] = (...args) => { spawned += 1; return original(...args); }; }",
    'syncBuiltinESMExports();',
    `const runners = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'packages/runners/index.js')).href)});`,
    'console.log(JSON.stringify({ spawned, pinned: runners.runnerToolingPinned() }));',
  ].join('\n');
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { spawned: 0, pinned: false });
});
