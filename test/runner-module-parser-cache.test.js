/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/runners/src/shell/runner-module-parser.js packages/runners/src/shell/runner-module-parser-worker.js */
/** The runner module parser keeps a process-lifetime cache [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createRunnerModuleParser, runnerModuleParserCompileCount } from '../packages/runners/src/shell/runner-module-parser.js';
import { runnerPackage } from '../packages/runners/src/shell/runner-package.js';
import { captureRunnerTooling } from '../packages/runners/src/shell/runner-tooling-snapshot.js';

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

  const fourth = createRunnerModuleParser();
  const before = runnerModuleParserCompileCount();
  fourth.parse([source], ['a.js']);
  fourth.parse([source], ['a.js']);
  fourth.parse([source], ['b.js']);
  fourth.close();
  assert.equal(runnerModuleParserCompileCount(), before + 2, 'the key is path plus content: a path parses once, a new path parses again');
  const fifth = createRunnerModuleParser();
  fifth.parse([`${source}export const d = 1;\n`], ['a.js']);
  fifth.close();
  assert.equal(runnerModuleParserCompileCount(), before + 3, 'the same path with changed content is re-parsed');
});

test('clause 1: the production importsIn call sites pass real paths, so a second pass over the real tree parses nothing [C7]', () => {
  const root = resolve(import.meta.dirname, '..');
  const first = runnerPackage(root);
  const afterPackage = runnerModuleParserCompileCount();
  assert.deepEqual(runnerPackage(root).files, first.files);
  assert.equal(runnerModuleParserCompileCount(), afterPackage, 'runner-package.js importsIn: a second pass parses nothing');

  captureRunnerTooling(root);
  const afterSnapshot = runnerModuleParserCompileCount();
  captureRunnerTooling(root);
  assert.equal(runnerModuleParserCompileCount(), afterSnapshot, 'runner-tooling-snapshot.js importsIn: a second pass parses nothing');
});
