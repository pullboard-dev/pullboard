/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/runners/src/shell/runner-module-parser.js packages/runners/src/shell/runner-module-parser-worker.js */
/** The runner module parser keeps a process-lifetime cache [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunnerModuleParser, runnerModuleParserCompileCount } from '../packages/runners/src/shell/runner-module-parser.js';

test('clause 1: a second parser in one process parses nothing again and a changed file is re-parsed [C7]', () => {
  const source = `import { a } from './cache-probe-${process.pid}.js';\nexport const b = a;\n`;
  const first = createRunnerModuleParser();
  let started = process.hrtime.bigint();
  const cold = first.parse([source]);
  const coldMs = Number(process.hrtime.bigint() - started) / 1e6;
  first.close();
  assert.equal(cold[0].compiles, true);
  const afterCold = runnerModuleParserCompileCount();

  const second = createRunnerModuleParser();
  started = process.hrtime.bigint();
  const warm = second.parse([source]);
  const warmMs = Number(process.hrtime.bigint() - started) / 1e6;
  second.close();
  assert.deepEqual(warm, cold);
  assert.equal(runnerModuleParserCompileCount(), afterCold, 'a repeated source is served from the cache');
  assert.ok(warmMs < coldMs, `cached parse ${warmMs.toFixed(2)} ms is faster than cold ${coldMs.toFixed(2)} ms`);

  const third = createRunnerModuleParser();
  const changed = third.parse([`${source}export const c = 1;\n`]);
  third.close();
  assert.equal(changed[0].compiles, true);
  assert.equal(runnerModuleParserCompileCount(), afterCold + 1, 'a changed file is parsed again');
});
