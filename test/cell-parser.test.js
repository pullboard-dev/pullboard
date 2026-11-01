/** @pullboard-test-input source-tree */
/** A lint run starts one real compile-only parser and retains the original report bytes [C7,P3]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bindingReadsForModules, cellLintReport, withCellLintParser } from '../packages/codemap/index.js';
import { commonJsIn, importsIn } from '../packages/gate/index.js';
import { fixture } from './cells-plan-fixture.js';
import { privateFixtureFiles, runFixtureChild } from './fixture-child.js';

test('one owned parser serves import and multiple binding batches, then exits [C7,P3]', async t => {
  const sources = ["import value from './leaf.js'; export default value;", "import('./dynamic.js');",
    "const require = value => value; require('node:fs');", "throw new Error('source must never execute');"];
  const modules = Array.from({ length: 300 }, (_, index) => ({ file: `leaf-${index}.js`,
    source: `import { value } from './leaf.js';\nexport const result = value + ${index};\n`,
    body: `                                \nexport const result = value + ${index};\n`, bindings: [{ local: 'value' }] }));
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
  const actual = withCellLintParser(compile => ({ imports: importsIn(sources, compile), common: commonJsIn(sources, compile),
    bindings: bindingReadsForModules(modules) }));
  assert.deepEqual(actual, expected);
  assert.equal(starts, 1, 'all parser batches share exactly one actual process');
  assert.equal(synchronous, 0, 'no per-batch compiler process remains inside the command scope');
  assert.equal((await exited).signal, 'SIGKILL', 'the owned worker really exits when the command completes');
});

test('the real lint CLI starts exactly one parser per cold run and prints unchanged report bytes [C7,P3]', t => {
  const box = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-parser-count-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = privateFixtureFiles(directory);
  files.write('starts.jsonl', '');
  files.write('count.mjs', `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
for (const name of ['spawn','spawnSync']) {
  const original=cp[name];
  /** Observe actual parser starts without replacing compiler execution or results. */
  cp[name]=function(...args) {
    const result=original(...args);
    if (args[0]===process.execPath && args[1].includes('--experimental-vm-modules'))
      appendFileSync(${JSON.stringify(join(files.root, 'starts.jsonl'))},JSON.stringify({name,pid:result.pid})+'\\n');
    return result;
  };
}
syncBuiltinESMExports();
`);
  const expected = JSON.stringify({ ...cellLintReport(box.root, { importsIn, commonJsIn }), growth: null }, null, 2) + '\n';
  const executable = fileURLToPath(new URL('../bin/cell-lints.js', import.meta.url));
  for (let run = 1; run <= 2; run++) {
    const result = runFixtureChild(process.execPath, [executable, '--report'], { cwd: box.root, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(files.root, 'count.mjs')).href}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, 'stdout remains byte-identical to the original compiler path');
    const starts = files.read('starts.jsonl').toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(starts.length, run, 'each actual CLI invocation starts exactly one V8 parser process');
    assert.ok(starts.every(start => start.name === 'spawn' && Number.isSafeInteger(start.pid)));
  }
});
