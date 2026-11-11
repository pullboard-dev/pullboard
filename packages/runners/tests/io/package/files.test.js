/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/index.js */
/** Private shipped-source fixtures; these tests do not claim execution on a physical runner [C7,P3]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { runnerPackage } from '../../../src/io/package.js';
import { workerBundleBytes } from '../../../src/io/package.js';
import { createRunnerModuleParser } from '../../../src/io/module/parser.js';
import { importsIn } from '../../../../gate/index.js';
import { commonJsIn } from '../../../../gate/index.js';
import { runtimeUrls } from '../../../src/logic/urls.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { currentRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { installRunnerPackage } from '../../../src/io/package/install.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../index.js';
import { packageFiles } from '../../../index.js';
import { toolSourcePath } from '../../../index.js';

/** Create isolated package bytes and remove only this test's owned temporary directory. */
function fixture(t, files = ['src', 'apps', 'packages/*/src']) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-package-copies-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  mkdirSync(root);
  /** Write ordinary private fixture files without touching production source or settings. */
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ type: 'module', files }));
  write('src/entry.js', "export { value } from '../packages/leaf/src/value.js';\n");
  write('packages/leaf/src/value.js', 'export const value = 42;\n');
  write('packages/leaf/tests/private.test.js', 'not shipped');
  write('outside-secret.txt', 'not shipped');
  write('.git/private-state', 'not shipped');
  return { root, directory, write };
}

/** Independently enumerate actual destination files rather than trusting the copy helper's returned manifest. */
function copiedFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? copiedFiles(join(root, entry.name), file) : [file];
  }).sort();
}

test('the private closure compiler preserves V8 edges and refusals without executing source [C7,P3]', t => {
  const f = fixture(t);
  const marker = join(f.directory, 'must-not-execute');
  const parser = createRunnerModuleParser();
  t.after(parser.close);
  const sources = [
    "import value from './value.js'; export * from 'node:path';",
    String.raw`await import('./\u006citeral.js');`,
    "const name = './computed.js'; await import(name);",
    "const require = () => {}; require('opaque');",
    "const generated = \"require('data')\";",
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  ];
  assert.deepEqual(importsIn(sources, parser.parse), importsIn(sources));
  assert.deepEqual(commonJsIn(sources, parser.parse), commonJsIn(sources));
  const repeated = parser.parse(["import './required.js';", "import './required.js';"]);
  repeated[0].imports.length = 0;
  assert.deepEqual(repeated[1].imports, ['./required.js'], 'one returned row cannot erase another source dependency');
  assert.deepEqual(parser.parse(["import './required.js';"])[0].imports, ['./required.js'],
    'a caller cannot poison the next trusted compile result by mutating an earlier reply');
  const runtime = String.raw`new URL('./\u0066ile.js', import.meta.url); new URL('../second.json', import.meta.url); new URL('./file.js', import.meta.url);`;
  assert.deepEqual(runtimeUrls(runtime, parser.parse), ['./file.js', '../second.json', './file.js']);
  const independentParser = createRunnerModuleParser();
  try {
    assert.deepEqual(runtimeUrls(runtime, parser.parse), runtimeUrls(runtime, independentParser.parse));
  } finally { independentParser.close(); }
  assert.equal(runtimeUrls('new URL(name, import.meta.url);', parser.parse), null);
  assert.throws(() => importsIn(['import {'], parser.parse), /does not compile/u);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' }, 'compile-only source never executes its filesystem effect');
});

test('a loaded controller refuses changed private compiler bytes before an optional rescan [C7,P3]', async t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  const snapshot = await import(pathToFileURL(join(installed, 'packages/runners/src/io/tooling/snapshot.js')).href);
  const loaded = snapshot.captureRunnerTooling(installed);
  for (const file of ['packages/runners/src/io/module/parser.js', 'packages/runners/src/io/module/parser/worker.js']) {
    const path = toolSourcePath(installed, file);
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n// changed after actual installed module load\n')]));
      assert.throws(() => snapshot.currentRunnerTooling(installed, loaded, { rescan: false }),
        error => error.code === 'RUNNER_TOOLING_CHANGED', 'the new controller-only compiler pair is guarded before rescanning');
    } finally { writeFileSync(path, original); }
  }
  assert.deepEqual(snapshot.currentRunnerTooling(installed, loaded), runnerPackage(installed));
});

test('a private compiler startup failure refuses instead of supplying an empty closure [C7,P3]', t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  writeFileSync(join(installed, 'packages/runners/src/io/module/parser/worker.js'), 'this is not valid module syntax {\n');
  const script = `import assert from 'node:assert/strict';
const {createRunnerModuleParser}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/module/parser.js')).href)});
const parser=createRunnerModuleParser();
try { assert.throws(()=>parser.parse([\"import './required.js';\"]),/private compiler did not return a valid bounded reply/u);
assert.throws(()=>parser.parse([]),/private compiler did not return a valid bounded reply/u); }
finally { parser.close(); }
console.log('COMPILER_STARTUP_REFUSED');`;
  // Budget: the existing ten-second compiler wait plus private child startup and failure cleanup.
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.match(result.stdout, /COMPILER_STARTUP_REFUSED/u);
});

test('a private compiler cannot replace a requested import with a forged empty reply [C7,P3]', t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  const marker = join(f.directory, 'forged-reply-prepared');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  writeFileSync(join(installed, 'packages/runners/src/io/module/parser/worker.js'), `import {existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
const directory=process.argv[2];
/** Publish an actual bounded but wrongly bound protocol reply in this private fixture. */
function reply() {
  if(!existsSync(join(directory,'request-1.json')))return;
  writeFileSync(${JSON.stringify(marker)},'prepared');
  const temporary=join(directory,'forged.tmp');
  writeFileSync(temporary,JSON.stringify({version:1,id:2,results:[{compiles:true,imports:[]}]}));
  renameSync(temporary,join(directory,'reply-1.json'));
  clearInterval(timer);
}
// Budget: await only this private request so the adversarial reply exercises the real file protocol.
const timer=setInterval(reply,2);reply();\n`);
  const script = `import assert from 'node:assert/strict';
const {createRunnerModuleParser}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/module/parser.js')).href)});
const parser=createRunnerModuleParser();
try { assert.throws(()=>parser.parse([\"import './required.js';\"]),/private compiler did not return a valid bounded reply/u); }
finally { parser.close(); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'prepared', 'the forged response was prepared, rather than an unrelated startup failure');
});

test('a compiler swap restored before its reply cannot erase a real import [C7,P3]', t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  const marker = join(f.directory, 'swapped-compiler-executed');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  const worker = join(installed, 'packages/runners/src/io/module/parser/worker.js');
  const original = readFileSync(worker, 'utf8');
  const forged = `import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(${JSON.stringify(worker)},${JSON.stringify(original)});
writeFileSync(${JSON.stringify(marker)},'executed');
const directory=process.argv[2];
/** Return a correctly bound but false result after restoring the original compiler bytes. */
function reply() {
  const input=join(directory,'request-1.json');
  if(!existsSync(input))return;
  const request=JSON.parse(readFileSync(input,'utf8'));
  const temporary=join(directory,'forged.tmp');
  writeFileSync(temporary,JSON.stringify({version:1,id:request.id,results:request.sources.map(()=>({compiles:true,imports:[]}))}));
  renameSync(temporary,join(directory,'reply-1.json'));clearInterval(timer);
}
// Budget: poll only this owned request until the ordinary parser closes its private child.
const timer=setInterval(reply,2);reply();`;
  const script = `import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
const actualSpawn=childProcess.spawn;let swaps=0;
childProcess.spawn=function(command,args,options){
  if(args?.includes('--experimental-vm-modules')){swaps++;writeFileSync(${JSON.stringify(worker)},${JSON.stringify(forged)});}
  return Reflect.apply(actualSpawn,this,arguments);
};syncBuiltinESMExports();
const {createRunnerModuleParser}=await import(${JSON.stringify(pathToFileURL(join(installed, 'packages/runners/src/io/module/parser.js')).href)});
const parser=createRunnerModuleParser();
try {
  try { assert.deepEqual(parser.parse(["import './required.js';"]),[{compiles:true,imports:['./required.js']}]); }
  catch(error){if(error.code!=='RUNNER_TOOLING_CHANGED')throw error;}
  assert.equal(swaps,1,'the real spawn boundary actually replaced the original compiler entry');
  assert.equal(existsSync(${JSON.stringify(marker)}),false,'the swapped compiler never executed');
} finally { parser.close();writeFileSync(${JSON.stringify(worker)},${JSON.stringify(original)}); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
});

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

test('an installed worker follows Node import-pattern prefix precedence [C7,P3]', t => {
  const f = fixture(t, ['src', 'apps', 'packages']);
  f.write('package.json', JSON.stringify({ type: 'module', files: ['src', 'apps', 'packages'], imports: {
    '#a/*/long': './packages/less/src/*.js', '#a/b/*': './packages/more/src/*.js',
  } }));
  f.write('apps/runner/src/io/scripts/worker.js', "import {value} from '#a/b/value/long'; console.log(value);\n");
  f.write('packages/less/src/b/value.js', "export const value = 'wrong-pattern';\n");
  f.write('packages/more/src/value/long.js', "export const value = 'longest-prefix';\n");
  const capsule = runnerPackage(f.root);
  assert.ok(Object.hasOwn(capsule.files, 'packages/more/src/value/long.js'));
  assert.equal(Object.hasOwn(capsule.files, 'packages/less/src/b/value.js'), false);
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const result = runFixtureChild(process.execPath, [join(runner, 'runtime', digest, capsule.entry)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'longest-prefix');
});

test('an installed worker executes a prefix-only Node builtin without copying it [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(db.prepare('SELECT 42 AS value').get().value); db.close();\n");
  const capsule = runnerPackage(f.root);
  assert.deepEqual(Object.keys(capsule.files), ['apps/runner/src/io/scripts/worker.js', 'package.json']);
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const result = runFixtureChild(process.execPath, [join(runner, 'runtime', digest, capsule.entry)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42', 'the genuine builtin executes in the installed worker');
});

test('an installed worker executes coverage with its source-relative reporter dependency [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/reporter.js', "export default async function* report(events) { for await (const event of events) if(event.type==='test:coverage') yield 'REAL_COVERAGE\\n'; }\n");
  const bodyMarker = join(f.directory, 'coverage-body.json');
  f.write('apps/runner/src/io/scripts/worker.js', `import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; const reporter = new URL('./reporter.js', import.meta.url); test('private coverage',()=>writeFileSync(${JSON.stringify(bodyMarker)},JSON.stringify({executed:true,node:process.version}))); console.log(reporter.pathname);\n`);
  const capsule = runnerPackage(f.root);
  assert.ok(Object.hasOwn(capsule.files, 'apps/runner/src/io/scripts/reporter.js'));
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const installed = join(runner, 'runtime', digest);
  const env = { ...process.env };
  // This independent Node test command must not inherit its parent's test harness context (#1390).
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--test', '--experimental-test-coverage',
    `--test-reporter=${join(installed, 'apps/runner/src/io/scripts/reporter.js')}`, join(installed, capsule.entry)], { env, encoding: 'utf8' });
  const diagnostic = `${result.context}\nstdout: ${(result.stdout ?? '').slice(-4096)}`;
  assert.equal(result.status, 0, diagnostic);
  assert.match(result.stdout, /REAL_COVERAGE/u, `the installed reporter consumes real native coverage events\n${diagnostic}`);
  const body = JSON.parse(readFileSync(bodyMarker, 'utf8'));
  assert.equal(body.executed, true, 'the actual private test body ran, not merely the launcher');
  assert.match(body.node, /^v\d+\./u);
});

test('runtime URL closure rejects missing unsafe and opaque paths while generated text stays data [C7,P3]', t => {
  const f = fixture(t);
  for (const expression of ["new URL('./missing.js', import.meta.url)",
    "new URL('../../outside.js', import.meta.url)", "new URL(name, import.meta.url)",
    "new URL('./reporter.js', unknownBase)"]) {
    f.write('apps/runner/src/io/scripts/worker.js', `const runtime = ${expression};\n`);
    assert.throws(() => runnerPackage(f.root), error => error.code === 'RUNNER_TOOLING_FILES');
  }
  f.write('apps/runner/src/io/scripts/worker.js', `// new URL('./missing.js', import.meta.url)\nconst generated = "new URL('./missing.js', import.meta.url)";\n`);
  assert.deepEqual(Object.keys(runnerPackage(f.root).files), ['apps/runner/src/io/scripts/worker.js', 'package.json']);
});


test('a loaded controller refuses changes to every derived runtime file before rescanning [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import '../../../../../packages/leaf/src/value.js';\n");
  f.write('packages/runners/index.js', 'export const controller = true;\n');
  f.write('apps/runner/src/io/controller.js', 'export const composition = true;\n');
  const loaded = captureRunnerTooling(f.root);
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
  for (const [file, original] of Object.entries(loaded.files)) {
    f.write(file, original + '\nnot valid JavaScript or JSON @@@');
    assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED', file);
    f.write(file, original);
  }
  f.write('packages/runners/index.js', loaded.controller + '\n// a different controller generation\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED');
  f.write('packages/runners/index.js', loaded.controller);
  f.write('apps/runner/src/io/controller.js', loaded.controllerEntry + '\n// a different native composition generation\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded, { rescan: false }), error => error.code === 'RUNNER_TOOLING_CHANGED');
  f.write('apps/runner/src/io/controller.js', loaded.controllerEntry);
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
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


/** Install actual published tooling into one private fixture without borrowing native execution receipts. */
function controllerFixture(t) {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  return { ...f, installed };
}

test('controller provider freshness follows its real package composition, not unrelated shipped engine leaves [C7,P3]', t => {
  const { installed } = controllerFixture(t);
  const loaded = captureRunnerTooling(installed);
  const unrelated = join(installed, 'packages/state/src/logic/engines/check-timing-engine.js');
  writeFileSync(unrelated, readFileSync(unrelated, 'utf8') + '\n// unrelated private generation\n');
  assert.deepEqual(currentRunnerTooling(installed, loaded), runnerPackage(installed),
    'an unrelated shipped file is not part of this controller generation');
  const provider = join(installed, 'packages/resources/src/io/controller/custody.js');
  writeFileSync(provider, readFileSync(provider, 'utf8') + '\n// actual composed provider changed\n');
  assert.throws(() => currentRunnerTooling(installed, loaded), { code: 'RUNNER_TOOLING_CHANGED' },
    'the actual transitive lifecycle provider still requires a fresh controller');
});

test('committed tooling binds literal Unicode blobs and ignores filtered working bytes before SSH [C7,P3]', t => {
  const box = cellSandbox(t);
  const installed = join(box.dir, 'tooling'), project = join(box.dir, 'project');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
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

test('the actual async controller retains fresh bridging and rejects a stale derived runtime before dispatch [C7,P3]', t => {
  const f = controllerFixture(t);
  const script = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(f.installed, 'packages/runners/index.js')).href)});
const options={runner:{host:'private-unused.invalid',slots:1,browser:0}};
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',options),error=>error.code==='RUNNER_SOURCE_CHANGED');
const resource=${JSON.stringify(toolSourcePath(f.installed, 'packages/resources/src/io/main.js'))};
writeFileSync(resource,readFileSync(resource,'utf8')+'\\n// changed after controller load\\n');
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',options),error=>error.code==='RUNNER_TOOLING_CHANGED');`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
});

for (const kind of ['opaque', 'unshipped']) {
  test(`the actual async controller preserves ${kind} runtime refusal captured at load [C7,P3]`, t => {
    const f = controllerFixture(t);
    if (kind === 'opaque') {
      const worker = join(f.installed, 'apps/runner/src/io/scripts/worker.js');
      writeFileSync(worker, readFileSync(worker, 'utf8') + '\nrequire(unknownRuntime);\n');
    } else {
      const manifest = join(f.installed, 'package.json');
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      value.files = ['package.json'];
      writeFileSync(manifest, JSON.stringify(value));
    }
    const script = `import assert from 'node:assert/strict';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(f.installed, 'packages/runners/index.js')).href)});
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',{runner:{host:'private-unused.invalid',slots:1,browser:0}}),error=>error.code==='RUNNER_TOOLING_FILES');`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.context);
  });
}


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


/** The private wake channel cannot supply source/results, and filesystem notifications remain a fallback. */
test('private compiler missing duplicate and spurious hints retain atomic request authority [C7,P3]',async t=>{
  const f=fixture(t);
  const protocol=join(f.directory,'protocol');mkdirSync(protocol);
  const worker=spawn(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning',resolve(import.meta.dirname,'../../../src/io/module/parser/worker.js'),protocol,String(process.pid)],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';worker.stderr.on('data',part=>{stderr+=part;});
  const closed=new Promise(resolve=>worker.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await closed;});
  /** Wait for an actual atomic reply; the bound is the existing private compiler protocol ceiling. */
  async function reply(id){
    const path=join(protocol,`reply-${id}.json`),end=Date.now()+10_000;
    while(!existsSync(path)&&Date.now()<end&&worker.exitCode===null&&worker.signalCode===null)await pause(2);
    assert.ok(existsSync(path),stderr);
    return JSON.parse(readFileSync(path,'utf8'));
  }
  /** Publish exactly the production regular-file request shape. */
  function request(id,sources){
    const temporary=join(protocol,`request-${id}.tmp`);
    writeFileSync(temporary,JSON.stringify({version:1,id,sources}));
    renameSync(temporary,join(protocol,`request-${id}.json`));
  }
  request(1,["import './first.js';"]); // Deliberately no wake hint: watcher/initial scan must still work.
  assert.deepEqual(await reply(1),{version:1,id:1,results:[{compiles:true,imports:['./first.js']}]});
  rmSync(join(protocol,'request-1.json'));rmSync(join(protocol,'reply-1.json'));
  const marker=join(f.directory,'must-not-execute');
  worker.send({id:999,imports:[],sources:[`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'forged');`]});
  worker.send(1);worker.send(1); // Old duplicate hints cannot manufacture the next response.
  request(2,["import './second.js';"]);worker.send(2);worker.send(2);
  assert.deepEqual(await reply(2),{version:1,id:2,results:[{compiles:true,imports:['./second.js']}]});
  assert.equal(existsSync(marker),false);
  rmSync(join(protocol,'request-2.json'));rmSync(join(protocol,'reply-2.json'));
  request(3,["import './watcher-fallback.js';"]); // No IPC hint after startup or previous replies.
  assert.deepEqual(await reply(3),{version:1,id:3,results:[{compiles:true,imports:['./watcher-fallback.js']}]});
  assert.deepEqual(readdirSync(protocol).filter(name=>name.startsWith('reply-')),['reply-3.json']);
});

/** Missing notifications must not strand a valid request; exercise the real worker with only watch delivery suppressed. */
test('private compiler drains atomic requests when watcher notifications are lost [C7,P3]', async t => {
  const f = fixture(t);
  const protocol = join(f.directory, 'lost-notification-protocol');
  mkdirSync(protocol);
  const wrapper = join(f.directory, 'lost-notification-worker.mjs');
  const entry = resolve(import.meta.dirname, '../../../src/io/module/parser/worker.js');
  writeFileSync(wrapper, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const actualWatch = fs.watch;
fs.watch = (directory, listener) => actualWatch(directory, () => {});
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(entry).href)});
`);
  /** Publish the same regular atomic request that production uses, without any IPC hint. */
  function publish(id, source) {
    const temporary = join(protocol, `request-${id}.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: 1, id, sources: [source] }));
    renameSync(temporary, join(protocol, `request-${id}.json`));
  }
  publish(1, "import './startup.js';");
  const worker = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
    wrapper, protocol, String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  worker.stderr.on('data', part => { stderr += part; });
  const closed = new Promise(resolve => worker.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed;
  });
  /** Retain the existing ten-second protocol ceiling and require an actual atomic result. */
  async function reply(id) {
    const file = join(protocol, `reply-${id}.json`), deadline = Date.now() + 10_000;
    while (!existsSync(file) && Date.now() < deadline && worker.exitCode === null && worker.signalCode === null) await pause(2);
    assert.ok(existsSync(file), `missing real reply ${id}: ${stderr}`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  assert.deepEqual(await reply(1), { version: 1, id: 1, results: [{ compiles: true, imports: ['./startup.js'] }] });
  rmSync(join(protocol, 'request-1.json'));
  rmSync(join(protocol, 'reply-1.json'));
  publish(2, "import './without-a-notification.js';");
  assert.deepEqual(await reply(2), { version: 1, id: 2, results: [{ compiles: true, imports: ['./without-a-notification.js'] }] });
});

