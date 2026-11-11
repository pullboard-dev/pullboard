/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/main.js packages/runners/index.js */
/** The moved runner controller keeps its private compiler independent and its loaded generation pinned [C7,P3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { copyPackageFiles } from '../../../src/io/package/files.js';
import { toolSourcePath } from '../../../src/io/package/files.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { currentRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');

/** Create a private source tree with one entry and remove only this test's owned temporary directory. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-controller-generation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  /** Write ordinary private fixture files without touching production source or settings. */
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ type: 'module', files: ['src', 'packages/*/src'] }));
  write('src/entry.js', "export { value } from '../packages/leaf/src/value.js';\n");
  write('packages/leaf/src/value.js', 'export const value = 42;\n');
  return { root, directory };
}

/** Private compiler imports must not initialize the unrelated public controller facade. */
test('private compiler stays independent while the public facade still initializes eagerly [C7,P3]', t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyPackageFiles(ROOT, installed);
  const facade = toolSourcePath(installed, 'packages/runners/src/io/main.js');
  writeFileSync(facade, 'throw new Error("FACADE_EAGER_MARKER");\n' + readFileSync(facade, 'utf8'));
  const script = `
import assert from 'node:assert/strict';
const {runnerPackage}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/package.js')).href)});
const {captureRunnerTooling}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/tooling/snapshot.js')).href)});
assert.equal(typeof captureRunnerTooling, 'function');
assert.equal(runnerPackage(${JSON.stringify(f.root)}, 'src/entry.js').files['src/entry.js'], ${JSON.stringify(readFileSync(join(f.root, 'src/entry.js'), 'utf8'))});
const {createRunnerModuleParser}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/module/parser.js')).href)});
const parser=createRunnerModuleParser();
try { assert.deepEqual(parser.parse(["import './private.js';"]),[{compiles:true,imports:['./private.js']}]); }
finally { parser.close(); }
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/index.js')).href)}), /FACADE_EAGER_MARKER/);
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const reader = toolSourcePath(installed, 'packages/runners/src/io/package.js');
  const source = readFileSync(reader, 'utf8');
  assert.ok(source.includes("from './module/parser.js'"));
  writeFileSync(reader, source.replace("from './module/parser.js'", "from '../../index.js'"));
  const backEdge = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
  assert.notEqual(backEdge.status, 0, 'the former private-to-barrel back edge triggers the planted facade');
  assert.match(backEdge.stderr, /FACADE_EAGER_MARKER/);
});

test('moved controller step bodies stay bound to the loaded runner generation [C7,P3]', t => {
  const installed = mkdtempSync(join(tmpdir(), 'pullboard-controller-generation-'));
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  copyPackageFiles(ROOT, installed);
  const loaded = captureRunnerTooling(installed);
  const index = join(installed, 'packages/runners/index.js');
  const originalIndex = readFileSync(index);
  try {
    writeFileSync(index, Buffer.concat([originalIndex, Buffer.from('\n// changed shared controller index\n')]));
    assert.throws(() => currentRunnerTooling(installed, loaded, { rescan: false }),
      error => error.code === 'RUNNER_TOOLING_CHANGED', 'packages/runners/index.js');
  } finally { writeFileSync(index, originalIndex); }
  for (const file of ['packages/runners/src/io/main.js', 'packages/runners/src/io/dispatch.js']) {
    const path = toolSourcePath(installed, file);
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n// changed moved controller body\n')]));
      assert.throws(() => currentRunnerTooling(installed, loaded, { rescan: false }),
        error => error.code === 'RUNNER_TOOLING_CHANGED', file);
    } finally { writeFileSync(path, original); }
  }
});
