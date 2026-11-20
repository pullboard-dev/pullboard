/** @pullboard-test-input source-tree */
/** Real private native execution through fake SSH capsules; never evidence of eight physical machines [C7,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
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
import { awaitNestedRun } from '../../../../../../packages/gate/heavy.js';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../../child.js';

const SOURCE = resolve(import.meta.dirname, '../../../../../..');
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** Run actual fixture Git with private identity and no changes to the person's repository. */
function git(box, ...args) {
  const result = runFixtureChild('git', args, { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
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

/** Construct real committed source and private SQLite pools without injecting any gate result. */
function fixture(t, { red = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-release-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = { dir, repo: join(dir, 'repo'), bin: join(dir, 'bin'), marks: join(dir, 'marks') };
  const home = join(dir, 'home'), machine = join(home, '.pullboard');
  for (const path of [box.repo, box.bin, box.marks, machine, join(box.repo, 'test')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    gate: { browserByLaunch: true, browserFreeChecks: true, timingRunner: false } }));
  box.env = { ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine,
    PATH: `${box.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Private Release Fixture', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Private Release Fixture', GIT_COMMITTER_EMAIL: 'release@example.invalid' };
  // Accepted fake-runner fixture isolation: these nested runs acquire their own actual private leases.
  for (const key of Object.keys(box.env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING|RELEASE)_/u.test(key)
    || ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete box.env[key];
  // Installed tooling is complete, but its vendor documentation tests are not this project's eight cases.
  box.tool = join(box.repo, '.tooling');
  const shipped = copyPackageFiles(SOURCE, box.tool);
  mkdirSync(join(box.repo, 'apps/cli/src/io/run'), { recursive: true });
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
  return box;
}

/** Execute the public producer in its own private process, preserving actual native admission and child custody. */
async function producer(box, checks) {
  const script = `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runReleaseGate,verifyNativeReleaseReceipt} from './.tooling/packages/gate/heavy.js';
import {runnerExecutionServices} from './.tooling/packages/runners/index.js';
import {landingExecutionServices} from './.tooling/packages/landing/index.js';
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
import {isStampedGreen} from './.tooling/packages/gate/heavy.js';
import {releaseReceiptBody,releaseParticipationDigest,releaseTiming} from './.tooling/packages/gate/heavy.js';
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

/**
 * Register actual worker-protocol controls; the importing wrapper decides when the native test gate may run them.
 * Each journey file installs one group (red or count1) so every file stays inside its 120 s budget [C7,V4].
 * Pull dispatch is the default: the one registered executor is this machine.
 */
export function installReleaseProducerCases(group) {
  // The red run binds this machine's one executor, as a pulled release does, so it needs no SSH capsule placement [C7].
  if (group === 'red') test('a red private release collects tiny shard results without a native envelope or green stamp [C7,V4]',
    { timeout: 180_000, cpuLoad: true }, async t => { // budget: a complete real private eight-file run, including red collection and cleanup.
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

  if (group === 'count1') {
    test('native private release records all 1 simulated registered executors [C7,V4]',
      { timeout: 180_000, cpuLoad: true }, async t => { // budget: actual private worker capsules, full collection and owned cleanup.
      const box = fixture(t);
      const result = await producer(box, `
const run=await runReleaseGate(root, { executionServices }), receipt=run.receipt;
assert.equal(receipt.participation.required.length,1);
assert.equal(new Set(receipt.participation.shards.map(shard=>shard.executor)).size,1);
assert.equal(receipt.participation.shards.length,1);
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
    });
  }
}
