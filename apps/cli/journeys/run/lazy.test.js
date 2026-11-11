/** @pullboard-test-input source-tree */
/** @pullboard-test-input packages/gate/tests/fixtures/budgets.js */
/** @pullboard-world-pin copies the shipped wall-clock budgets helper into the private installed copy the runners package is imported from. */
/** Ordinary runner loading stays light; full gates and truthful repository selection retain their inputs [C7,V4]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  posix,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import { selectAffectedTests } from '../../../../packages/gate/index.js';
import { testClosures } from '../../../../packages/gate/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { testsNeedCpuRunner } from '../../../../packages/gate/index.js';
import {
  copyPackageFiles,
  toolSourcePath,
} from '../../../../packages/runners/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RUNNER = join(ROOT, 'packages/gate/src/io/run/tests.js');
/** The engine the launcher starts; the source guards below read this file, where the code lives. */
const ENGINE = join(ROOT, 'packages/gate/src/io/run-tests.js');
const HEAVY = ['packages/gate/src/io/main.js', 'packages/store/index.js', 'packages/store/src/io/board.js', 'packages/state/src/io/machine.js'];
const FULL_GATE_PROOF = ['packages/gate/src/io/main.js', 'packages/store/src/io/board.js', 'packages/state/index.js'];

test('clause 1: a real named-file run meets its declared ten-second import-check budget [C7,V4]', { cpuLoad: true }, t => {
  const declaredBudget = 10_000;
  const started = performance.now();
  assert.equal(testsNeedCpuRunner(ROOT, ['apps/cli/journeys/run/lazy.test.js']), true,
    'the optimized classifier still recognizes this real CPU declaration');
  const elapsed = performance.now() - started;
  t.diagnostic(`named-file import check: ${elapsed.toFixed(1)}ms; declared budget ${declaredBudget}ms`);
  assert.ok(elapsed < declaredBudget, `named-file import check took ${elapsed.toFixed(1)}ms`); // budget: declared #2425 ten-second named-file import-check limit.
  const box = fixture();
  assert.equal(testsNeedCpuRunner(box.repo, ['web/plain.test.js']), false, 'ordinary tests do not acquire CPU authority');
  const child = runFixtureChild(process.execPath, [RUNNER, '--test-reporter=tap', 'web/plain.test.js'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.context ?? child.stderr + child.stdout);
  const phases = /^run-tests: phases selection ([\d.]+)s, admission ([\d.]+)s, tests ([\d.]+)s, cleanup ([\d.]+)s, total ([\d.]+)s$/mu.exec(child.stderr);
  assert.ok(phases, 'the real node packages/gate/src/io/run/tests.js <one file> run prints its phase line');
  t.diagnostic(`real named-file run: selection ${phases[1]}s of total ${phases[5]}s; declared budget ${declaredBudget / 1000}s`);
  assert.ok(Number(phases[1]) * 1000 < declaredBudget, `the real run's selection phase (the named-file import check) took ${phases[1]}s`); // budget: declared #2425 ten-second named-file import-check limit.
});

test('clause 2: every named run prints one per-phase timing line, successful or refused [C7,V4]', () => {
  const box = fixture();
  for (const [extra, status] of [[[], 0], [['--test-name-pattern=no-such-case'], 1]]) {
    const child = runFixtureChild(process.execPath, [RUNNER, '--test-reporter=tap', ...extra, 'web/plain.test.js'], {
      cwd: box.repo, env: box.env, encoding: 'utf8',
    });
    assert.equal(child.status, status, child.context ?? child.stderr + child.stdout);
    const lines = child.stderr.split('\n').filter(line => line.startsWith('run-tests: phases '));
    assert.equal(lines.length, 1, 'each actual controller prints once');
    assert.match(lines[0], /selection [\d.]+s, admission [\d.]+s, tests [\d.]+s, cleanup [\d.]+s, total [\d.]+s/u);
  }
});

/** The package front doors the run-tests engine imports statically; #3056 trimmed the closure to this set and main holds it. */
const MAIN_STATIC_FRONT_DOORS = ['../../../git/index.js'];

test('clause 3: packages/gate/src/io/run/tests.js adds no static front-door import that main lacks [C7,V4]', () => {
  const source = readFileSync(ENGINE, 'utf8');
  const doors = [...source.matchAll(/^import\s[^;]*?\sfrom\s+['"]([^'"]+\/index\.js)['"]/gmu)].map(match => match[1]).sort();
  assert.deepEqual(doors, MAIN_STATIC_FRONT_DOORS, 'a static package front door pulls its whole barrel into every run-tests start');
  assert.doesNotMatch(source, /^import\s[^;]*?from\s+['"]\.\.\/\.\.\/index\.js['"]/mu, 'the gate front door stays a dynamic import');
});

test('clause 1: packages/gate/src/io/run/tests.js is a launcher whose only static import of the repository is the gate entry [C7,V4]', () => {
  const source = readFileSync(RUNNER, 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map(match => match[1]).filter(name => !name.startsWith('node:'));
  assert.deepEqual(specifiers, ['../../../bin/run-tests.js'], 'the launcher reaches the engine through one gate entry and nothing else statically');
  assert.ok(source.split('\n').length < 30, 'the engine lives in gate, not in the launcher');
});

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
  const runners = [...modules.keys()].filter(file => /^apps\/cli\/journeys\/runner\/runners\/.*\.test\.js$/u.test(file));
  assert.ok(runners.length > 0, 'the split runner scenarios remain actual importer roots');
  const roots = ['packages/gate/tests/run-tests-kill.test.js', 'packages/gate/tests/run-tests-timeout.test.js', ...runners];
  const releaseSource = modules.get('packages/landing/src/io/queue.js');
  const releaseImports = importsIn([releaseSource])[0];
  assert.ok(!releaseImports.includes('../../../store/index.js'), 'release capture avoids the eager store front door');
  for (const reader of ['../../../store/src/shell/board-event-log.js', '../../../store/src/shell/board-query.js', '../../../store/src/core/board-milestones-read.js']) {
    assert.ok(releaseSource.includes(`load('${reader}')`), `release capture loads its lazy read-only store module ${reader}`);
  }
  for (const name of ['openBoardReadOnly', 'boardId', 'listItems', 'milestones']) assert.match(releaseSource, new RegExp(`\\b${name}\\b`), `release capture uses canonical reader ${name}`);
  assert.ok(!releaseImports.includes('../../../store/src/shell/board.js'), 'release capture does not import the writer facade');
  const parsed = new Map();
  const known = new Set();
  for (const root of roots) {
    const pending = [root], seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      if (file === 'packages/store/src/io/board.js') { known.add(root); break; }
      if (!modules.has(file)) continue;
      if (!parsed.has(file)) parsed.set(file, importsIn([modules.get(file)])[0]);
      for (const edge of parsed.get(file)) {
        if (edge.startsWith('.')) pending.push(posix.normalize(posix.join(posix.dirname(file), edge)));
      }
    }
  }
  for (const root of known) {
    const closure = closures.get(root);
    if (closure.files !== null) assert.ok(closure.files.includes('packages/store/src/io/board.js'), `${root} complete closure retains its independently proved literal board dependency`);
  }
  return known;
}

test('clause 1: a plain test run loads no gate board or machine modules through its runner [C7,V4]', { timeout: 90_000 }, // budget: one real private admission and test-file child; hang ceiling only.
() => {
  const box = fixture();
  const { child, urls } = observed(box, [RUNNER, '--test-reporter=tap', 'web/plain.test.js']);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /# pass 1\b/u);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the actual candidate runner was observed');
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'packages/gate/src/io/slot.js')).href), 'ordinary admission actually ran');
  for (const file of HEAVY) assert.ok(!urls.includes(pathToFileURL(join(ROOT, file)).href), `${file} must remain lazy in an ordinary run`);
});

test('clause 2: a plain run retains lazy modules with current-release-first queue policy enabled [C7,V4]', { timeout: 90_000 }, // budget: one actual private policy-enabled admission and child; hang ceiling only.
() => {
  const box = fixture({ currentReleaseFirst: true });
  const { child, urls } = observed(box, [RUNNER, '--test-reporter=tap', 'web/plain.test.js']);
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gate.queue.currentReleaseFirst, true);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /# pass 1\b/u);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the actual candidate runner was observed');
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'packages/gate/src/io/slot.js')).href), 'ordinary policy-enabled admission actually ran');
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
  // The full gate loads the real board and the state front door [C7].
  for (const file of FULL_GATE_PROOF) assert.ok(urls.includes(pathToFileURL(join(ROOT, file)).href), `a real full gate retains ${file}`);
});

test('a board change selects its real importers in the actual committed repository [C7,V4]', { timeout: 120_000 }, // budget: complete actual committed import graph; correctness only, no benchmark.
() => {
  // Keep every committed module, including the runner's arbitrary reporter declaration; no synthetic shortened graph.
  const selection = selectAffectedTests(ROOT, { base: 'HEAD', commit: 'HEAD', changed: ['packages/store/src/io/board.js'] });
  assert.equal(selection.full, false, selection.reason);
  assert.ok(selection.files.includes('apps/cli/journeys/resume/board.test.js'), 'the board contract is an actual importer');
  const { closures, modules } = testClosures(ROOT, 'HEAD');
  const known = knownLiteralBoardImporters(closures, modules);
  for (const [file, closure] of closures) {
    if (closure.files !== null) continue;
    assert.ok(selection.files.includes(file), `unknown root ${file} remains conservatively selected`);
    assert.ok(closure.reason, `unknown root ${file} has a nonempty reason`);
    assert.ok(selection.reason.includes(file), `selection discloses unknown root ${file}`);
    assert.ok(selection.reason.includes(closure.reason), `selection discloses the reason for ${file}`);
  }
  const expected = [...closures].filter(([file, closure]) => closure.files === null || closure.files.includes('packages/store/src/io/board.js')
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
  mkdirSync(join(installed, 'packages/gate/tests/fixtures'), { recursive: true });
  copyFileSync(join(ROOT, 'packages/gate/tests/fixtures/budgets.js'), join(installed, 'packages/gate/tests/fixtures/budgets.js'));
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
assert.equal(runners.runnerToolingPinned(), true, 'the first runner operation pins the tooling generation');
// The closure capture waits for first use, so the generation's first read spawns the capture.
assert.ok(runners.loadedToolingFiles({ rescan: false }).files, 'the pinned generation matches the unchanged tooling');
assert.ok(globalThis.__spawned.some(entry => entry.startsWith('spawn ')), 'the first use of the pinned generation captures the tooling');
appendFileSync(${JSON.stringify(toolSourcePath(installed, 'packages/runners/src/io/dispatch.js'))}, '\\n// changed after the first dispatch\\n');
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
