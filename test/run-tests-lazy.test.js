/** @pullboard-test-input source-tree */
/** Ordinary runner loading stays light; full gates and truthful repository selection retain their inputs [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { selectAffectedTests, testClosures } from '../src/affected-tests.js';
import { importsIn } from '../src/module-imports.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = join(ROOT, 'bin/run-tests.js');
const HEAVY = ['src/gate.js', 'src/board.js', 'src/machine.js'];

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

/** Independently trace literal imports for cache-unknown roots; never invent a removed board edge. */
function knownUncacheableImporters(closures, modules) {
  const roots = ['test/run-tests-kill.test.js', 'test/run-tests-timeout.test.js', 'test/runners.test.js'];
  const releaseImports = importsIn([modules.get('src/release-queue.js')])[0];
  for (const file of ['board-read-open.js', 'board-query.js', 'board-read-auxiliary.js']) assert.ok(releaseImports.includes(`./${file}`), `release capture uses canonical reader ${file}`);
  assert.ok(!releaseImports.includes('./board.js'), 'release capture does not import the writer facade');
  const parsed = new Map();
  const known = new Set();
  for (const root of roots) {
    assert.equal(closures.get(root).files, null, 'literal inspection does not make unknown cache closures reusable');
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
  return known;
}

test('a plain test run loads no gate board or machine modules through its runner [C7,V4]', { timeout: 90_000 }, // budget: one real private admission and test-file child; hang ceiling only.
() => {
  const box = fixture();
  const { child, urls } = observed(box, [RUNNER, '--test-reporter=tap', 'web/plain.test.js']);
  assert.equal(readFileSync(box.ran, 'utf8'), 'executed');
  assert.match(child.stdout, /# pass 1\b/u);
  assert.ok(urls.includes(pathToFileURL(RUNNER).href), 'the actual candidate runner was observed');
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'src/gate-slot.js')).href), 'ordinary admission actually ran');
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
  assert.ok(urls.includes(pathToFileURL(join(ROOT, 'src/gate-slot.js')).href), 'ordinary policy-enabled admission actually ran');
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
  const gate = pathToFileURL(join(ROOT, 'src/gate.js')).href;
  const source = `const { runGate } = await import(${JSON.stringify(gate)}); const result = await runGate(process.cwd(), {gate:'node --test --test-reporter=tap web/plain.test.js'}, {trustStamp:false}); if (!result.isGreen) throw new Error(result.output); console.log('FULL_GATE_EXECUTED');`;
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
  const known = knownUncacheableImporters(closures, modules);
  const expected = [...closures].filter(([file, closure]) => closure.files?.includes('src/board.js')
    || sourceTreeReader(modules.get(file)) || known.has(file)).map(([file]) => file).sort();
  assert.deepEqual(selection.files, expected, 'only actual transitive importers and declared source-tree readers are selected');
  assert.ok(selection.files.length < closures.size, 'unrelated tests do not become board dependencies through the runner');
});
