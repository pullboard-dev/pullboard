/** @pullboard-test-input apps/runner/src/io/controller.js apps/runner/src/io/scripts/worker.js packages/resources/src/io/controller/custody.js packages/resources/src/io/main.js packages/runners/src/io/module/parser/worker.js packages/state/src/logic/engines/check-timing-engine.js */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/index.js */
/** Private shipped-source fixtures for package file selection and the runner closure; these tests do not claim execution on a physical runner [C7,P3]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { runnerPackage } from '../../../src/io/package.js';
import { workerBundleBytes } from '../../../src/io/package.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { currentRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { installRunnerPackage } from '../../../src/io/package/install.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../index.js';
import { copyRunnerPackage } from '../../fixtures/package.js';
import { packageFiles } from '../../../index.js';
import { toolSourcePath } from '../../../index.js';
import { fixture } from '../../fixtures/package-files.js';
import { copiedFiles } from '../../fixtures/package-files.js';



test('a fixture copy includes added packages entries and nothing outside package files [C7,P3]', t => {
  const f = fixture(t);
  const destination = join(f.directory, 'fixture');
  const expected = ['package.json', 'packages/leaf/src/value.js', 'src/entry.js'];
  assert.deepEqual(packageFiles(f.root), expected);
  copyPackageFiles(f.root, destination);
  assert.deepEqual(copiedFiles(destination), expected);
  assert.equal(readFileSync(join(destination, 'packages/leaf/src/value.js'), 'utf8'), 'export const value = 42;\n');
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).files, ['src', 'apps', 'packages/*/src']);
});

test('package copies refuse escaping patterns, selected symlinks and recursive destinations [C7,P3]', t => {
  const f = fixture(t);
  assert.throws(() => copyPackageFiles(f.root, join(f.root, 'copy')), /outside its source/u);
  symlinkSync(join(f.root, 'outside-secret.txt'), join(f.root, 'src/linked.js'));
  assert.throws(() => packageFiles(f.root), /not a regular file/u);
  f.write('package.json', JSON.stringify({ files: ['../outside'] }));
  assert.throws(() => packageFiles(f.root), /unsafe package files entry/u);
});

test('package files honor a later exclusion and name any entry they cannot parse [C7,P3]', t => {
  const f = fixture(t, ['src', 'packages', '!packages/**/*.test.js']);
  assert.deepEqual(packageFiles(f.root), ['package.json', 'packages/leaf/src/value.js', 'src/entry.js'],
    'the later exclusion removes the private test and keeps the module it did not match');
  f.write('package.json', JSON.stringify({ files: ['src', '!src/entry.js', 'src/entry.js'] }));
  assert.deepEqual(packageFiles(f.root), ['package.json', 'src/entry.js'], 'a later inclusion re-admits a path the exclusion removed');
  f.write('package.json', JSON.stringify({ files: ['!src'] }));
  assert.throws(() => packageFiles(f.root), /needs at least one inclusion entry/u, 'an exclusion-only list cannot silently ship nothing');
  f.write('package.json', JSON.stringify({ files: ['src', '!!src/entry.js'] }));
  assert.throws(() => packageFiles(f.root), /unsupported package files entry: "!!src\/entry.js"/u, 'a double negation is refused by name');
});

test('5642 clause 1: a root-wide exclusion never walks folders no inclusion reaches, such as agent worktrees [C7,P3]', t => {
  const f = fixture(t, ['src', 'packages', '!*/*/tests/**']);
  // An unreadable folder outside every inclusion stands in for hundreds of worktrees, or one removed mid-walk.
  f.write('.claude/worktrees/seat/src/entry.js', 'export {};\n');
  chmodSync(join(f.root, '.claude/worktrees'), 0o000);
  try { assert.deepEqual(packageFiles(f.root), ['package.json', 'packages/leaf/src/value.js', 'src/entry.js']); }
  finally { chmodSync(join(f.root, '.claude/worktrees'), 0o755); }
});

test('a computed runner copy follows a new packages import without a hand-kept list [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import {value} from '../../../../../packages/leaf/src/value.js'; console.log(value);\n");
  f.write('packages/leaf/src/unused.js', 'export const unused = true;\n');
  const capsule = runnerPackage(f.root);
  assert.deepEqual(Object.keys(capsule.files), ['apps/runner/src/io/scripts/worker.js', 'package.json', 'packages/leaf/src/value.js']);
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const installed = join(runner, 'runtime', digest);
  assert.deepEqual(copiedFiles(installed), Object.keys(capsule.files));
  const result = runFixtureChild(process.execPath, [join(installed, capsule.entry)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42', 'the installed worker really loads the newly reached package');
});

test('runner closure refuses the named unshipped import, and a closure past 1 MiB raw is returned whole for the capsule bound and the raw ratchet to judge (#4140) [C7,P3]', t => {
  const f = fixture(t, ['src', 'apps']);
  f.write('apps/runner/src/io/scripts/worker.js', "import '../../../../../packages/leaf/src/value.js';\n");
  assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES'
    && error.message.includes('packages/leaf/src/value.js') && error.message.includes('leaves package.json files'));
  f.write('apps/runner/src/io/scripts/worker.js', "import 'unshipped-external-package';\n");
  assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES'
    && error.message.includes('apps/runner/src/io/scripts/worker.js') && error.message.includes('unshipped-external-package'));
  f.write('apps/runner/src/io/scripts/worker.js', "const dependency = require('./hidden.js');\n");
  assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES'
    && error.message.includes('apps/runner/src/io/scripts/worker.js') && error.message.includes('CommonJS'));
  for (const loader of ["createRequire(import.meta.url)('./hidden.js')", String.raw`\u0072equire('./hidden.js')`]) {
    f.write('apps/runner/src/io/scripts/worker.js', `const dependency = ${loader};\n`);
    assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES'
      && error.message.includes('apps/runner/src/io/scripts/worker.js') && error.message.includes('CommonJS'));
  }
  f.write('apps/runner/src/io/scripts/worker.js', `export const large = ${JSON.stringify('x'.repeat(1_048_576))};\n`);
  assert.ok(Buffer.byteLength(JSON.stringify(runnerPackage(f.root).files)) > 1_048_576, 'the raw size is measured, not refused, here');
});

test('runner installation rejects a correctly hashed escaping path without writing outside its capsule [C7,P3]', t => {
  const f = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ 'package.json': '{"type":"module"}', '../outside.js': 'untrusted' }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  assert.throws(() => installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner), /unsafe capsule file/u);
  assert.deepEqual(readdirSync(join(runner, 'runtime')), [], 'owned partial installation is cleaned after refusal');
});

test('runtime URL closure rejects missing unsafe and opaque paths while generated text stays data [C7,P3]', t => {
  const f = fixture(t);
  for (const expression of ["new URL('./missing.js', import.meta.url)",
    "new URL('../../outside.js', import.meta.url)"]) {
    f.write('apps/runner/src/io/scripts/worker.js', `const runtime = ${expression};\n`);
    assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES');
  }
  for (const expression of ["new URL(name, import.meta.url)", "new URL('./reporter.js', unknownBase)"]) {
    f.write('apps/runner/src/io/scripts/worker.js', `const runtime = ${expression};\n`);
    assert.deepEqual(Object.keys(runnerPackage(f.root).files), ['apps/runner/src/io/scripts/worker.js', 'package.json'],
      `${expression} resolves at run time and adds no edge (#6201)`);
  }
  f.write('apps/runner/src/io/scripts/worker.js', `// new URL('./missing.js', import.meta.url)\nconst generated = "new URL('./missing.js', import.meta.url)";\n`);
  assert.deepEqual(Object.keys(runnerPackage(f.root).files), ['apps/runner/src/io/scripts/worker.js', 'package.json']);
});

test('freshness follows added package dependencies and ignores files outside the runtime [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import '../../../../../packages/leaf/src/value.js';\n");
  f.write('packages/runners/index.js', 'export const controller = true;\n');
  f.write('apps/runner/src/io/controller.js', 'export const composition = true;\n');
  const loaded = captureRunnerTooling(f.root);
  f.write('packages/leaf/src/unrelated.js', 'export const outsideRuntime = true;\n');
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
  f.write('packages/leaf/src/value.js', "export { added } from './new.js';\n");
  f.write('packages/leaf/src/new.js', 'export const added = 43;\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED');
  const restarted = captureRunnerTooling(f.root);
  assert.ok(Object.hasOwn(currentRunnerTooling(f.root, restarted).files, 'packages/leaf/src/new.js'));
  assert.throws(() => currentRunnerTooling(f.root, null), error => error.code === 'RUNNER_TOOLING_CHANGED');
});

test('a warmed derived snapshot still refuses newly selected symlinks outside its runtime [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import '../../../../../packages/leaf/src/value.js';\n");
  f.write('packages/runners/index.js', 'export const controller = true;\n');
  f.write('apps/runner/src/io/controller.js', 'export const composition = true;\n');
  const loaded = captureRunnerTooling(f.root);
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
  symlinkSync(join(f.root, 'outside-secret.txt'), join(f.root, 'src/new-selected-link.js'));
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_FILES'
    && error.message.includes('not a regular file'), 'warm analysis never grants authority to newly selected filesystem bytes');
});

/** Exercise the actual closure reader while observing only its whole-files serialization work. */
test('runner closure byte accounting preserves escaped bytes without growing-object serialization [C7,P3]', t => {
  const f = fixture(t, ['src']);
  const names = ["apostrophe'key.txt", 'quote"key.txt', 'é🧩.txt', 'e\u0301.txt', ...Array.from({length:64},(_,i)=>`data-${i}.txt`)];
  const source = names.map(name=>`import ${JSON.stringify('./'+name)};`).join('\n');
  f.write('src/entry.js',source);
  for(const name of names) f.write('src/'+name, 'quote" slash\\ newline\n tab\t astral🧩');
  const stringify = JSON.stringify;
  let dictionaries=0;
  JSON.stringify = function(value,...args) {
    if(value&&typeof value==='object'&&Object.hasOwn(value,'src/entry.js')&&Object.values(value).every(part=>typeof part==='string')) dictionaries++;
    return Reflect.apply(stringify,this,[value,...args]);
  };
  let runtime;
  try { runtime=runnerPackage(f.root,'src/entry.js'); }
  finally { JSON.stringify=stringify; }
  const expected=Object.fromEntries(['package.json','src/entry.js',...names.map(name=>'src/'+name)].sort().map(file=>[file,readFileSync(join(f.root,file),'utf8')]));
  assert.deepEqual(runtime.files,expected);
  assert.equal(Buffer.byteLength(JSON.stringify(runtime.files)),Buffer.byteLength(JSON.stringify(expected)));
  assert.equal(dictionaries,0,'derive encodes each new key/value without reserializing the growing files dictionary');
  f.write('src/separator\u2028.txt','existing unsupported path');
  f.write('src/entry.js',source+"\nimport './separator\\u2028.txt';");
  assert.throws(()=>runnerPackage(f.root,'src/entry.js'),error=>error.code==='RUNNER_TOOLING_FILES'&&error.message.includes('leaves package.json files'),'existing line-separator path refusal is preserved');
});

test('the worker bundle size the raw ratchet records is the exact JSON byte count for ASCII and Unicode (#4140) [C7,P3]', t => {
  for(const unicode of [false,true]) {
    const f=fixture(t,['src']);
    f.write('src/entry.js',"import './payload.txt';\n");
    const bytes=value=>Buffer.byteLength(JSON.stringify({'package.json':readFileSync(join(f.root,'package.json'),'utf8'),'src/entry.js':readFileSync(join(f.root,'src/entry.js'),'utf8'),'src/payload.txt':value}));
    const prefix=unicode?'🧩é"\\\n\t':'';
    const exact=prefix+'x'.repeat(1_048_576-bytes(prefix));
    assert.equal(bytes(exact),1_048_576);
    f.write('src/payload.txt',exact);
    assert.equal(workerBundleBytes(f.root,'src/entry.js'),1_048_576);
    f.write('src/payload.txt',exact+'x');
    assert.equal(workerBundleBytes(f.root,'src/entry.js'),1_048_577,'one more byte is measured as one more byte');
  }
});

test('runner closure retains the 4096 file cap independently of byte accounting [C7,P3]', t => {
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

test('committed tooling binds literal Unicode blobs and ignores filtered working bytes before SSH [C7,P3]', t => {
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
