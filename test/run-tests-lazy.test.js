/** @pullboard-test-input source-tree */
/** Ordinary runner loading stays light; full gates and truthful repository selection retain their inputs [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { selectAffectedTests, testClosures } from '../src/affected-tests.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = join(ROOT, 'bin/run-tests.js');
const HEAVY = ['src/gate.js', 'src/board.js', 'src/machine.js'];

/** Register a real ESM load observer in the independent fixture controller, with no application-loader replacement. */
function moduleObserver(box) {
  const trace = join(box.dir, 'loaded.jsonl');
  const hook = join(box.dir, 'observe-loader.mjs');
  const probe = join(box.dir, 'observe.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    'let trace;',
    'export function initialize(data) { trace = data.trace; }',
    "export async function load(url, context, nextLoad) { const result = await nextLoad(url, context); appendFileSync(trace, JSON.stringify(url) + '\\n'); return result; }",
  ].join('\n'));
  writeFileSync(probe, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hook).href)}, { data: { trace: ${JSON.stringify(trace)} } });\n`);
  return { probe, trace };
}

/** Use ordinary native admission against a private Git/SQLite board and private machine; the test supplies no live marker. */
function fixture() {
  const box = helpers.project('node --test --test-reporter=tap web/plain.test.js');
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  box.ran = join(box.dir, 'plain-ran');
  writeFileSync(join(box.repo, 'web/plain.test.js'), [
    "import { test } from 'node:test'; import { writeFileSync } from 'node:fs';",
    `test('plain worker really executes', () => writeFileSync(${JSON.stringify(box.ran)}, 'executed'));`,
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
  const urls = readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { child, urls };
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
  const expected = [...closures].filter(([file, closure]) => closure.files?.includes('src/board.js')
    || modules.get(file).startsWith('/** @pullboard-test-input source-tree */')).map(([file]) => file).sort();
  assert.deepEqual(selection.files, expected, 'only actual transitive importers and declared source-tree readers are selected');
  assert.ok(selection.files.length < closures.size, 'unrelated tests do not become board dependencies through the runner');
});
