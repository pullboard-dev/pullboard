/** @pullboard-test-input apps/runner/src/io/controller.js apps/runner/src/io/scripts/worker.js packages/resources/src/io/controller/custody.js packages/resources/src/io/main.js packages/runners/src/io/module/parser/worker.js packages/state/src/logic/engines/check-timing-engine.js */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/index.js */
/** Private shipped-source fixtures for the closure compiler child; these tests do not claim execution on a physical runner [C7,P3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createRunnerModuleParser } from '../../../src/io/module/parser.js';
import { importsIn } from '../../../../gate/index.js';
import { commonJsIn } from '../../../../gate/index.js';
import { runtimeUrls } from '../../../src/logic/urls.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyRunnerPackage } from '../../fixtures/package.js';
import { fixture } from '../../fixtures/package-files.js';

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
  assert.deepEqual(runtimeUrls('new URL(name, import.meta.url);', parser.parse), [], 'a computed path is a runtime value, not a literal edge (#6201)');
  assert.throws(() => importsIn(['import {'], parser.parse), /does not compile/u);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' }, 'compile-only source never executes its filesystem effect');
});

test('a private compiler startup failure refuses instead of supplying an empty closure [C7,P3]', t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), installed);
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
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), installed);
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
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), installed);
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
