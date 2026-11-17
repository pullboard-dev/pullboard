/** @pullboard-test-input apps/runner/src/io/controller.js apps/runner/src/io/scripts/worker.js packages/resources/src/io/controller/custody.js packages/resources/src/io/main.js packages/runners/src/io/module/parser/worker.js packages/state/src/logic/engines/check-timing-engine.js */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/index.js */
/** Runner closure file-cap cases moved out of files.test.js; they claim no physical runner [C7,P3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runnerPackage } from '../../../src/io/package.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { copyRunnerPackage } from '../../fixtures/package.js';
import { toolSourcePath } from '../../../index.js';
import { fixture } from '../../fixtures/package-files.js';

test('runners.files-closure.runner-closure-retains-the-4096-file: clause 1: runner closure retains the 4096 file cap independently of byte accounting [C7,P3]', t => {
  const f=fixture(t,['src']);
  const names=Array.from({length:4094},(_,i)=>`data-${i}.txt`);
  for(const name of names) f.write('src/'+name,'');
  const source=names.map(name=>`import './${name}';`).join('\n');
  f.write('src/entry.js',source);
  assert.equal(Object.keys(runnerPackage(f.root,'src/entry.js').files).length,4096);
  f.write('src/extra.txt','');
  f.write('src/entry.js',source+"\nimport './extra.txt';");
  assert.throws(()=>runnerPackage(f.root,'src/entry.js'),error=>error.code==='RUNNER_TOOLING_FILES'&&error.message.includes('file-count bound'));
});

test('runners.files-closure.committed-tooling-binds-literal-unicode-blobs: clause 2: committed tooling binds literal Unicode blobs and ignores filtered working bytes before SSH [C7,P3]', t => {
  const box = cellSandbox(t);
  const installed = join(box.dir, 'tooling'), project = join(box.dir, 'project');
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), installed);
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), 'Private committed source.\n');
  writeFileSync(join(installed, 'apps/runner/src/io/scripts/[literal]*.js'), '\ufeffexport const value = "café 🚀";\n');
  const worker = join(installed, 'apps/runner/src/io/scripts/worker.js');
  writeFileSync(worker, readFileSync(worker, 'utf8') + '\nimport "./[literal]*.js";\n');
  for (const root of [installed, project]) {
    box.git(root, 'init', '-q', '-b', 'main');
    box.git(root, 'config', 'core.autocrlf', 'false');
    box.git(root, 'add', '-A');
    box.git(root, 'commit', '-q', '-m', 'test: private committed tooling bytes');
  }
  const marker = join(box.dir, 'ssh-attempt');
  mkdirSync(join(box.dir, 'bin'));
  box.env.PATH = `${join(box.dir, 'bin')}:${box.env.PATH}`;
  writeFileSync(join(box.dir, 'bin/ssh'), `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(255);\n`, { mode: 0o700 });
  // Each attempt reports why a transport refused, so a non-SSH failure cannot satisfy this control.
  let transportAttempt = 0;
  const run = expected => {
    const host = `private-tooling-${++transportAttempt}.invalid`;
    const script = `import assert from 'node:assert/strict';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/index.js')).href)});
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',{runner:{host:${JSON.stringify(host)},slots:1,browser:0}}),
  error=>{ console.log(JSON.stringify({name:error.name,code:error.code,diagnostic:error.diagnostic})); return ${expected === 'transport' ? "error.name==='RunnerDropped'" : "error.code==='RUNNER_TOOLING_CHANGED'"}; });`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: project, env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    return result.stdout;
  };
  run('transport');
  assert.equal(readFileSync(marker, 'utf8'), 'called', 'exact Git bytes, including literal path characters and Unicode, reach the private transport');
  rmSync(marker);
  const resource = toolSourcePath(installed, 'packages/resources/src/io/main.js'), resourcePath = relative(installed, resource);
  writeFileSync(resource, readFileSync(resource, 'utf8').replace(/\r?\n/gu, '\r\n'));
  box.git(installed, 'config', 'core.autocrlf', 'true');
  writeFileSync(join(installed, '.git/info/attributes'), `${resourcePath} text eol=crlf\n`);
  box.git(installed, 'add', '--renormalize', resourcePath);
  assert.equal(box.git(installed, 'diff', '--cached', '--name-only'), '', 'filter normalization retains the original committed blob');
  assert.equal(box.git(installed, 'status', '--porcelain'), '', 'Git filtering reports clean while the working bytes differ from the committed blob');
  const filtered = run('transport');
  assert.ok(existsSync(marker), filtered);
  assert.equal(readFileSync(marker, 'utf8'), 'called', 'filtered working bytes are ignored; the private transport receives committed tooling');
});
