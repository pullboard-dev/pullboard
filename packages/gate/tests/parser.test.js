/** @pullboard-test-input packages/codemap/src/io/cell/parser/worker.js packages/codemap/src/io/cell/scripts/lints.js */
/** A lint run starts one real compile-only parser and retains the original report bytes [C7,P3]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bindingReadsForModules } from '../../codemap/index.js';
import { cellLintReport } from '../../codemap/index.js';
import { withCellLintParser } from '../../codemap/index.js';
import { commonJsIn } from '../heavy.js';
import { importsIn } from '../heavy.js';
import { fixture } from '../../landing/tests/fixtures/plan.js';
import { privateFixtureFiles } from './fixtures/child.js';
import { runFixtureChild } from './fixtures/child.js';

test('gate.parser.one-owned-parser-controller-serves: one owned parser controller serves import and multiple binding batches, then exits [C7,P3]', async t => {
  const sources = ["import value from './leaf.js'; export default value;", "import('./dynamic.js');",
    "const require = value => value; require('node:fs');", "throw new Error('source must never execute');"];
  const modules = Array.from({ length: 300 }, (_, index) => ({ file: `leaf-${index}.js`,
    source: `import { value } from './leaf.js';\nexport const result = value + ${index};\n`,
    body: `                                \nexport const result = value + ${index};\n`, bindings: [{ local: 'value' }] }));
  modules.push({ file: 'invalid.js', source: 'export const value = ;', body: 'export const value = ;', bindings: [{ local: 'value' }] });
  const expected = { imports: importsIn(sources), common: commonJsIn(sources), bindings: bindingReadsForModules(modules) };
  const originalSpawn = childProcess.spawn, originalSync = childProcess.spawnSync;
  let starts = 0, synchronous = 0, exited;
  t.mock.method(childProcess, 'spawn', (...args) => {
    starts++;
    const child = originalSpawn(...args);
    exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return child;
  });
  t.mock.method(childProcess, 'spawnSync', (...args) => { synchronous++; return originalSync(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let retained;
  const actual = withCellLintParser(compile => {
    retained = compile;
    return { imports: importsIn(sources, compile), common: commonJsIn(sources, compile), bindings: bindingReadsForModules(modules) };
  });
  assert.deepEqual(actual, expected);
  assert.throws(() => retained(sources), /compiler setup failed/u, 'a completed command cannot restart its worker through a retained callback');
  assert.equal(starts, 1, 'all parser batches share exactly one owned controller');
  assert.equal(synchronous, 0, 'no per-batch compiler process remains inside the command scope');
  const keepAlive = setInterval(() => {}, 100);
  try { assert.deepEqual(await exited, { code: 0, signal: null }, 'the owned controller closes after observing its compiler exit'); }
  finally { clearInterval(keepAlive); }
});

test('gate.parser.compiler-rotations-hand-off-fresh: compiler rotations hand off to a fresh supervisor without losing replies [C7,P3]', t => {
  const original = childProcess.spawn;
  let starts = 0;
  t.mock.method(childProcess, 'spawn', (...args) => {
    if (args[0] === process.execPath && args[1].includes('--supervise')) starts++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const sources = Array.from({ length: 128 }, (_, index) => `import value from './leaf-${index}.js'; export default value;`);
  withCellLintParser(parse => {
    for (let batch = 0; batch < 8; batch++) { // Production rotates a supervisor every 256 compiler rotations; a budget of 4 reaches the same hand-off twice in 8 batches.
      const rows = parse(sources);
      assert.equal(rows.length, sources.length, 'one row for every source handed in');
      assert.deepEqual(rows[0], { compiles: true, imports: ['./leaf-0.js'] });
    }
  }, { supervisorBudget: 4 });
  assert.equal(starts, 2, 'the controller replaces its supervisor and can close at a rotation boundary');
});

test('gate.parser.real-lint-cli-starts-one: the real lint CLI starts one parser controller per cold run and prints unchanged report bytes [C7,P3]', t => {
  const box = fixture(t);
  const files = privateFixtureFiles('pullboard-parser-count-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('starts.jsonl', '');
  files.write('count.mjs', `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
for (const name of ['spawn','spawnSync']) {
  const original=cp[name];
  /** Observe actual parser starts without replacing compiler execution or results. */
  cp[name]=function(...args) {
    const result=original(...args);
    if (args[0]===process.execPath && args[1].includes('--supervise'))
      appendFileSync(${JSON.stringify(join(files.root, 'starts.jsonl'))},JSON.stringify({name,pid:result.pid})+'\\n');
    return result;
  };
}
syncBuiltinESMExports();
`);
  const expected = JSON.stringify({ ...cellLintReport(box.root, { importsIn, commonJsIn }), growth: null }, null, 2) + '\n';
  const executable = fileURLToPath(new URL('../../codemap/src/io/cell/scripts/lints.js', import.meta.url));
  const reportRuns = 2;
  for (let run = 1; run <= reportRuns; run++) {
    const result = runFixtureChild(process.execPath, [executable, '--report'], { cwd: box.root, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(files.root, 'count.mjs')).href}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, 'stdout remains byte-identical to the original compiler path');
    const starts = files.read('starts.jsonl').toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(starts.length, run, 'each actual CLI invocation starts exactly one parser controller');
    assert.ok(starts.every(start => start.name === 'spawn' && Number.isSafeInteger(start.pid)));
  }
  const initialized = runFixtureChild(process.execPath, [executable, '--init'], { cwd: box.root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const checked = runFixtureChild(process.execPath, [executable, '--check'], { cwd: box.root, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(files.root, 'count.mjs')).href}` } });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, '');
  assert.equal(files.read('starts.jsonl').toString('utf8').trim().split('\n').length, reportRuns + 1,
    'the actual cold --check run also starts exactly one parser controller');
});

/** Real worker requests continue when filesystem watch hints are lost [C7,P3]. */
test('gate.parser.parser-drains-unhinted-atomic-requests: parser drains unhinted atomic requests after startup [C7,P3]', async t => {
  const files = privateFixtureFiles('pullboard-parser-lost-hint-');
  const protocol = join(files.root, 'protocol');
  mkdirSync(protocol);
  const entry = fileURLToPath(new URL('../../codemap/src/io/cell/parser/worker.js', import.meta.url));
  files.write('worker.mjs', `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const watch=fs.watch; fs.watch=(dir, listener)=>watch(dir,()=>{}); syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  /** Publish a complete request without a watch or IPC hint. */
  function publish(id, source) {
    const temporary = join(protocol, `request-${id}.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: 1, id, sources: [source] }));
    renameSync(temporary, join(protocol, `request-${id}.json`));
  }
  publish(1, "import './first.js';");
  const worker = childProcess.spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    join(files.root, 'worker.mjs'), protocol, String(process.pid)], { stdio: 'ignore' });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await exited; rmSync(files.root, { recursive: true, force: true }); });
  /** Wait within the production request deadline for the worker's actual response. */
  async function reply(id) {
    const file = join(protocol, `reply-${id}.json`), deadline = Date.now() + 10_000;
    while (!existsSync(file) && Date.now() < deadline && worker.exitCode === null && worker.signalCode === null)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(file), `missing reply ${id}`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  assert.deepEqual(await reply(1), { version: 1, id: 1, results: [{ compiles: true, imports: ['./first.js'] }] });
  rmSync(join(protocol, 'request-1.json')); rmSync(join(protocol, 'reply-1.json'));
  publish(2, "import './second.js';");
  assert.deepEqual(await reply(2), { version: 1, id: 2, results: [{ compiles: true, imports: ['./second.js'] }] });
});

test('gate.parser.slow-real-batch-worker-survives: a slow real batch worker survives the old deadline and a hung worker reports timeout [C7,P3]', async t => {
  const files = privateFixtureFiles('pullboard-parser-delay-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('slow.cjs', "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);\n");
  files.write('hung.cjs', "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n");
  const spawn = childProcess.spawn;
  let preload = 'slow.cjs';
  t.mock.method(childProcess, 'spawn', (command, args, options) => spawn(command,
    ['--require', join(files.root, preload), ...args], options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  // The production waits are 10 s plus a load-scaled extension; the same shape at a smaller scale: the worker outlasts the base wait and still answers inside the extension.
  const result = withCellLintParser(parse => parse(["import './real.js';", 'export const broken = ;']), { waits: { baseMs: 500, extensionMs: 30_000 } });
  assert.deepEqual(result[0], { compiles: true, imports: ['./real.js'] });
  assert.deepEqual(result[1], { compiles: false, imports: [] }, 'a real syntax failure remains a failed source');
  preload = 'hung.cjs';
  assert.throws(() => withCellLintParser(parse => parse(['export const value = 1;']), { waits: { baseMs: 300, extensionMs: 700 } }),
    error => error.code === 'CELL_BINDING_TIMEOUT' && /extended batch wait/u.test(error.message));
});

