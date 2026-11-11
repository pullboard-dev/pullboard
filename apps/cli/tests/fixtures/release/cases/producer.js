/** @pullboard-test-input source-tree */
/** Real private native execution through fake SSH capsules; never evidence of eight physical machines [C7,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../../../../packages/runners/index.js';
import { awaitNestedRun } from '../../../../../../packages/gate/index.js';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../../child.js';
import { installRegistrationProbeStandIn } from '../../runner/ssh.js';

const SOURCE = resolve(import.meta.dirname, '../../../../../..');
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** Run actual fixture Git with private identity and no changes to the person's repository. */
function git(box, ...args) {
  const result = runFixtureChild('git', args, { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

/** Map explicit fake host names to independent private homes while executing the actual native worker command. */
function installSsh(box) {
  const source = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2), divider=args.indexOf('--');
const host=args[divider+1], command=args[divider+2];
const workers=${JSON.stringify(box.workers)};
const worker=workers[host];
if(divider<0 || !worker || typeof command!=='string') process.exit(255);
const env={PATH:process.env.PATH,HOME:worker.home,PULLBOARD_HOME:worker.home,
 PULLBOARD_MACHINE_HOME:worker.machine,TMPDIR:process.env.TMPDIR,LANG:'C',LC_ALL:'C',TZ:'UTC'};
const child=spawn('/bin/sh',['-c',command],{cwd:worker.root,env,stdio:['pipe','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
child.once('error',()=>{process.exitCode=255;});
child.once('close',(code,signal)=>{
 appendFileSync(${JSON.stringify(box.requests)},JSON.stringify({host,code,signal})+'\\n');
 process.exitCode=signal?128:(code??255);
});
`;
  writeFileSync(join(box.bin, 'ssh'), source, { mode: 0o700 });
}

/** A tiny committed file records actual completion and asserts that private orchestration tokens do not reach test bodies. */
function tinyTest(name, box, red) {
  return `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {test} from 'node:test';
test('private producer file ${name}',()=>{
 for(const key of ['PULLBOARD_RELEASE_EXECUTORS','PULLBOARD_LANDING_COLLECTION_ID','PULLBOARD_LANDING_COLLECT_ALL']) assert.equal(process.env[key],undefined,key+' leaked');
 writeFileSync(${JSON.stringify(join(box.marks, `${name}.json`))},JSON.stringify({file:${JSON.stringify(name)},pid:process.pid,node:process.version}));
 assert.equal(${JSON.stringify(red && name === 'a')},false,'intentional private release red');
});\n`;
}

/** Construct real committed source, private SQLite pools and registered fake hosts without injecting any gate result. */
function fixture(t, { red = false, hosts = 7 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-release-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = { dir, repo: join(dir, 'repo'), bin: join(dir, 'bin'), marks: join(dir, 'marks'),
    requests: join(dir, 'fake-ssh.jsonl'), workers: {} };
  const home = join(dir, 'home'), machine = join(home, '.pullboard');
  for (const path of [box.repo, box.bin, box.marks, machine, join(box.repo, 'test')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    gate: { browserByLaunch: true, browserFreeChecks: true, timingRunner: false } }));
  for (let i = 0; i < hosts; i++) {
    const host = `synthetic-release-host-${i + 1}`;
    const worker = { home: join(dir, host, 'home'), machine: join(dir, host, 'home', '.pullboard'), root: join(dir, host, 'worker') };
    for (const path of [worker.home, worker.machine, worker.root]) mkdirSync(path, { recursive: true });
    writeFileSync(join(worker.machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
    box.workers[host] = worker;
  }
  box.env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine,
    PATH: `${box.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Private Release Fixture', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Private Release Fixture', GIT_COMMITTER_EMAIL: 'release@example.invalid' };
  // Accepted fake-runner fixture isolation: these nested runs acquire their own actual private leases.
  for (const key of Object.keys(box.env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING|RELEASE)_/u.test(key)
    || ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete box.env[key];
  // Installed tooling is complete, but its vendor documentation tests are not this project's eight cases.
  box.tool = join(box.repo, '.tooling');
  const shipped = copyPackageFiles(SOURCE, box.tool);
  mkdirSync(join(box.repo, 'packages/gate/src/io/run'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), `/** @pullboard-module-loads .tooling/apps/cli/src/io/run/tests.js */
/** Invoke the real installed dispatcher without replacing its arguments, output or verdict. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../../../../../.tooling/apps/cli/src/io/run/tests.js',import.meta.url));
const child=spawnSync(process.execPath,[...process.execArgv,entry,...process.argv.slice(2)],{stdio:'inherit'});
if(child.error)throw child.error;
if(child.signal)process.kill(process.pid,child.signal);
else process.exitCode=child.status??1;
`);
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ name: 'pullboard', version: '0.0.0-fixture', private: true, type: 'module' }) + '\n');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ gate: 'node apps/cli/src/io/run/tests.js', landingShards: 1 }));
  for (const name of NAMES) writeFileSync(join(box.repo, `test/${name}.test.js`), tinyTest(name, box, red));
  git(box, 'init', '-q', '-b', 'main');
  git(box, 'add', '.');
  git(box, 'commit', '-q', '-m', 'test: commit private native release fixture');
  assert.deepEqual(git(box, 'ls-files', '-z', '--', '.tooling', 'apps/cli/src/io/run/tests.js').split('\0').filter(Boolean).sort(),
    [...shipped.map(file => '.tooling/' + file), 'apps/cli/src/io/run/tests.js'].sort(), 'the real launcher and complete installed package enter the immutable release source');
  installRegistrationProbeStandIn({ bin: box.bin });
  for (const host of Object.keys(box.workers)) {
    const added = runFixtureChild(process.execPath, [join(box.tool, 'apps/cli/pullboard.js'), 'runner', 'add', host,
      '--slots', '1', '--browser', '0', '--json'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  installSsh(box); // Job statistics exclude the separately recorded real registration probes.
  return box;
}

/** Execute the public producer in its own private process, preserving actual native admission and child custody. */
async function producer(box, checks) {
  const script = `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runReleaseGate,verifyNativeReleaseReceipt} from './.tooling/packages/gate/index.js';
import {runnerExecutionServices} from './.tooling/packages/runners/index.js';
import {landingExecutionServices} from './.tooling/packages/landing/index.js';
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
import {isStampedGreen} from './.tooling/packages/gate/index.js';
import {releaseReceiptBody,releaseParticipationDigest} from './.tooling/packages/gate/index.js';
import {closeBoard} from './.tooling/packages/store/index.js';
import {openBoard} from './.tooling/apps/lib/index.js';
const root=process.cwd();
const board=openBoard(join(root,'.git','pullboard','board.sqlite'));closeBoard(board);
try {
${checks}
} catch (error) {
  const receipts=[];
  try { for (const file of readdirSync(join(root,'.git','pullboard','gate-receipts')).filter(file=>file.endsWith('.json')).slice(-20)) {
    receipts.push(JSON.parse(readFileSync(join(root,'.git','pullboard','gate-receipts',file),'utf8')));
  } } catch { /* A missing receipt is itself evidence; preserve the original failure. */ }
  console.error('PRIVATE_RELEASE_DIAGNOSTIC '+JSON.stringify({
    head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),
    status:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}),receipts,
  }));
  throw error;
}
`;
  return await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env: box.env, encoding: 'utf8' }));
}

/** Register actual worker-protocol controls; the importing wrapper decides when the native test gate may run them. */
export function installReleaseProducerCases() {
  test('native private release producer covers eight simulated executors and binds stored bytes to current source [C7,V4]',
    { timeout: 180_000, cpuLoad: true }, async t => { // budget: seven real private worker capsules and their owned cleanup.
    const box = fixture(t);
    const result = await producer(box, `
const run=await runReleaseGate(root, { executionServices });
const receipt=run.receipt,id=receipt.participation.id;
assert.equal(receipt.gateReceipt.kind,'release');
assert.equal(receipt.gateReceipt.collection.full,true);assert.equal(receipt.gateReceipt.collection.complete,true);
assert.equal(receipt.gateReceipt.collection.plannedFiles,8);assert.equal(receipt.gateReceipt.collection.completedFiles,8);
assert.equal(receipt.participation.required.length,8);
assert.equal(new Set(receipt.participation.shards.map(s=>s.executor)).size,8);
assert.deepEqual(receipt.participation.shards.flatMap(s=>s.files).sort(),receipt.gateReceipt.collection.files);
assert.ok(receipt.participation.shards.every(s=>s.green&&s.complete&&s.cleanupVerified));
assert.deepEqual(verifyNativeReleaseReceipt(root,id, executionServices),receipt);
assert.equal(isStampedGreen(root),true);
assert.equal(verifyNativeReleaseReceipt(root,'not-a-native-id', executionServices),null);
const expected={head:receipt.participation.head,tree:receipt.participation.tree,command:receipt.participation.command,required:receipt.participation.required};
const original=readFileSync(run.file,'utf8');
assert.equal(original,releaseReceiptBody(receipt,expected));
const substitutions=[
 p=>{p.shards[0].command='0'.repeat(64);},
 p=>{[p.shards[0].executor,p.shards[1].executor]=[p.shards[1].executor,p.shards[0].executor];},
 p=>{p.startedAt=new Date(Date.parse(p.startedAt)-1).toISOString();},
 p=>{p.finishedAt=new Date(Date.parse(p.finishedAt)+1).toISOString();}
];
for(const substitute of substitutions){
 const substituted=structuredClone(receipt);substitute(substituted.participation);
 assert.equal(releaseReceiptBody(substituted,expected),null,'changed participation loses the observed gate binding');
 writeFileSync(run.file,JSON.stringify(substituted)+'\\n');
 try { assert.equal(verifyNativeReleaseReceipt(root,id, executionServices)===null,true,'valid participation substitutions cannot inherit native custody'); }
 finally { writeFileSync(run.file,original); }
 substituted.gateReceipt.participationDigest=releaseParticipationDigest(substituted.participation);
 const substitutedBytes=releaseReceiptBody(substituted,expected);
 assert.ok(substitutedBytes,'a forged matching hash preserves structure but cannot alter the private native gate record');
 writeFileSync(run.file,substitutedBytes);
 try { assert.equal(verifyNativeReleaseReceipt(root,id, executionServices)===null,true,'recomputing a forged digest cannot inherit native custody'); }
 finally { writeFileSync(run.file,original); }
}
assert.deepEqual(verifyNativeReleaseReceipt(root,id, executionServices),receipt,'the unmodified real native receipt remains valid');
const forged=structuredClone(receipt);forged.participation.shards[0].files=['test/not-planned.test.js'];
writeFileSync(run.file,JSON.stringify(forged)+'\\n');
assert.equal(verifyNativeReleaseReceipt(root,id, executionServices),null,'tampering a private envelope cannot create native custody');
writeFileSync(run.file,original);
writeFileSync('after-release.txt','a different accepted private head');
execFileSync('git',['add','after-release.txt']);execFileSync('git',['commit','-qm','test: advance private accepted head']);
assert.equal(verifyNativeReleaseReceipt(root,id, executionServices),null,'old green bytes cannot authorize a new head');
assert.equal(isStampedGreen(root),false);
`);
    assert.equal(result.status, 0, result.context);
    assert.deepEqual(readdirSync(box.marks).sort(), NAMES.map(name => `${name}.json`));
    const versions = new Set();
    for (const file of readdirSync(box.marks)) {
      const observation = JSON.parse(readFileSync(join(box.marks, file), 'utf8'));
      assert.ok(Number.isSafeInteger(observation.pid) && observation.pid > 0);
      assert.match(observation.node, /^v\d+\./u);
      versions.add(observation.node);
    }
    console.log(`private simulated release: eight test bodies observed Node ${[...versions].sort().join(', ')}; no physical eight-host claim`);
    const calls = readFileSync(box.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual([...new Set(calls.map(call => call.host))].sort(), Object.keys(box.workers).sort());
  });

  test('a red private release collects tiny shard results without a native envelope or green stamp [C7,V4]',
    { timeout: 180_000, cpuLoad: true }, async t => { // budget: a complete real private eight-shard run, including red collection and cleanup.
    const box = fixture(t, { red: true });
    const result = await producer(box, `
await assert.rejects(()=>runReleaseGate(root, { executionServices }),error=>error.code==='GATE_RUN_EVIDENCE');
assert.equal(isStampedGreen(root),false);
let receipts=[];try{receipts=readdirSync(join(root,'.git','pullboard','release-receipts'));}catch(error){if(error.code!=='ENOENT')throw error;}
assert.deepEqual(receipts,[]);
`);
    assert.equal(result.status, 0, result.context);
    assert.deepEqual(readdirSync(box.marks).sort(), NAMES.map(name => `${name}.json`), 'full collection still observes all eight tiny files when one is red');
  });

  for (const count of [1, 7]) {
    test(`native private release records all ${count} simulated registered executors [C7,V4]`,
      { timeout: 180_000, cpuLoad: true }, async t => { // budget: actual private worker capsules, full collection and owned cleanup.
      const box = fixture(t, { hosts: count - 1 });
      const result = await producer(box, `
const run=await runReleaseGate(root, { executionServices }), receipt=run.receipt;
assert.equal(receipt.participation.required.length,${count});
assert.equal(new Set(receipt.participation.shards.map(shard=>shard.executor)).size,${count});
assert.equal(receipt.participation.shards.length,${count});
assert.equal(receipt.gateReceipt.collection.full,true);
assert.equal(receipt.gateReceipt.collection.complete,true);
assert.equal(receipt.gateReceipt.collection.plannedFiles,8);
assert.equal(receipt.gateReceipt.collection.completedFiles,8);
assert.deepEqual(receipt.participation.shards.flatMap(shard=>shard.files).sort(),receipt.gateReceipt.collection.files);
assert.ok(receipt.participation.shards.every(shard=>shard.green&&shard.complete&&shard.cleanupVerified));
assert.deepEqual(verifyNativeReleaseReceipt(root,receipt.participation.id, executionServices),receipt);
assert.equal(isStampedGreen(root),true);
`);
      assert.equal(result.status, 0, result.context);
      assert.deepEqual(readdirSync(box.marks).sort(), NAMES.map(name => `${name}.json`));
      if (count > 1) {
        const calls = readFileSync(box.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual([...new Set(calls.map(call => call.host))].sort(), Object.keys(box.workers).sort());
      }
    });
  }
}
