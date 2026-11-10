/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js */
/** The runner module parser keeps a process-lifetime cache [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createRunnerModuleParser } from '../../../src/io/module/parser.js';
import { runnerModuleParserCompileCount } from '../../../src/io/module/parser.js';
import { runnerPackage } from '../../../src/io/package.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';

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

test('clause 1 and clause 2: the production importsIn call sites pass real paths, so a second pass over the real tree parses nothing [C7]', () => {
  const root = resolve(import.meta.dirname, '../../../../..');
  const first = runnerPackage(root);
  const afterPackage = runnerModuleParserCompileCount();
  assert.deepEqual(runnerPackage(root).files, first.files);
  assert.equal(runnerModuleParserCompileCount(), afterPackage, 'runner-package.js importsIn: a second pass parses nothing');

  captureRunnerTooling(root);
  const afterSnapshot = runnerModuleParserCompileCount();
  captureRunnerTooling(root);
  assert.equal(runnerModuleParserCompileCount(), afterSnapshot, 'runner-tooling-snapshot.js importsIn: a second pass parses nothing');
  const entry = resolve(root, 'apps/runner/src/io/controller.js');
  const probe = createRunnerModuleParser();
  const bytes = readFileSync(entry, 'utf8');
  const beforeProbe = runnerModuleParserCompileCount();
  probe.parse([bytes], [entry]);
  probe.close();
  assert.equal(runnerModuleParserCompileCount(), beforeProbe, 'the controller entry is cached under its real file path, not a synthetic one');
});
