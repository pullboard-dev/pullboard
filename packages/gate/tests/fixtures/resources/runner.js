/** @pullboard-module-loads packages/resources/index.js packages/config/src/io/settings.js */
/** Private native queue and CLI controls for opt-in submit/review runner-only admission [C7,Q1]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';
import { createE2eHelpers } from '../../../../../apps/cli/tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
} from '../runner/ssh.js';
import { fixtureAdd } from '../testkit.js';
import { fixturePolicy } from '../testkit.js';
import { refusalTrialFile } from '../../../index.js';
import { trialLedgerKey } from '../../../index.js';

const RESOURCES = pathToFileURL(resolve(import.meta.dirname, '../../../../resources/index.js')).href;
const DOCTRINE = pathToFileURL(resolve(import.meta.dirname, '../../../../doctrine/index.js')).href;
const SETTINGS = pathToFileURL(resolve(import.meta.dirname, '../../../../config/src/io/settings.js')).href;
const TEMP = [];
const helpers = createE2eHelpers();
after(helpers.cleanup);
after(() => { for (const root of TEMP) rmSync(root, { recursive: true, force: true }); });

/** Execute the real resource queue in a separate private machine without inheriting its caller's leases. */
function queueRun(body) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-runner-only-'));
  TEMP.push(root);
  const home = join(root, 'machine');
  mkdirSync(home);
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: home, PULLBOARD_HOME: home };
  const script = `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {takeResource,listResources} from ${JSON.stringify(RESOURCES)};
import {gateRunnerAdmission} from ${JSON.stringify(SETTINGS)};
const root=${JSON.stringify(root)},home=${JSON.stringify(home)};
const runner={host:'private-runner',slots:1,browser:0};
const base={name:'gate',scope:'machine',root,capacity:1,remote:true,
  runnerProvider:()=>[runner],runnersFirstProvider:()=>true};
${body}`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    env, encoding: 'utf8', timeout: 10_000,
  }); // budget: private sub-second queue deadlines must terminate without an immortal waiter.
  assert.equal(result.status, 0, result.context ?? result.stderr);
  return result.stdout;
}

/** Write only private machine policy, preserving all unrelated settings produced by native setup. */
function policy(box, runnersOnly, runnerWaitMs = 80) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...previous, gateSlots: 1, browserSlots: 1,
    gate: { ...previous.gate, runnersOnly, runnerWaitMs } }));
}

/** Require native CLI success before using any fixture result as setup evidence. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result;
}

/** Install the new cases in the existing frozen resources entry, without a second test entry. */
export function installRunnerOnlyCases({ verificationProject }) {
  test('runner-only empty, incompatible and busy pools wait and refuse without a local or short slot [C7,Q1]', () => {
    for (const mode of ['empty', 'incompatible', 'busy']) {
      const output = queueRun(`
const mode=${JSON.stringify(mode)};
const held=mode==='busy'?await takeResource({...base,runnerOnly:true,agent:'held-runner'}):null;
const started=Date.now(),cutoff=started+80;
let waited=false;
try {
  await assert.rejects(takeResource({...base,agent:'runner-only-waiter',runnerOnly:true,
    browser:mode==='incompatible',browserCapacityProvider:()=>1,shortEligible:true,shortCapacityProvider:()=>1,
    runnerProvider:()=>mode==='empty'?[]:[runner],runnerWaitMs:80,runnerDeadlineAt:cutoff,
    memory:()=>{
      waited ||= listResources({scope:'machine'}).some(row=>row.line.some(waiter=>waiter.agent==='runner-only-waiter'));
      return null;
    },
    onWait:state=>{if(!state.admitted)waited=true;}}),error=>error.code==='RUNNER_WAIT_DEADLINE'
      && error.message.includes(new Date(cutoff).toISOString())
      && error.message.includes(mode==='empty'?'no registered runner':mode==='busy'?'private-runner: busy':'browser capacity required'));
  assert.ok(waited,'a real queue waiter was observed');
  assert.ok(Date.now()>=cutoff,'the refusal follows the captured cutoff');
  assert.ok(!listResources({scope:'machine'}).some(row=>row.line.some(waiter=>waiter.agent==='runner-only-waiter')),'refused waiter is removed');
  console.log('REFUSED_WITHOUT_LOCAL_BODY',mode);
} finally {held?.release();}`);
      assert.match(output, /REFUSED_WITHOUT_LOCAL_BODY/u);
    }
  });

  test('ordinary local fallback and free registered runner admission keep their existing identities [C7,Q1]', () => {
    const output = queueRun(`
const held=await takeResource({...base,runnerOnly:true,agent:'held-runner'});
try {
  const ordinary=await takeResource({...base,agent:'ordinary-local'});
  assert.equal(ordinary.runner,undefined,'default-off admission still takes the free local slot');
  ordinary.release();
} finally {held.release();}
const remote=await takeResource({...base,runnerOnly:true,agent:'runner-positive',runnerWaitMs:80});
try {assert.equal(remote.runner.host,runner.host);console.log('ACTUAL_REGISTERED_POOL_ADMISSION');}
finally {remote.release();}`);
    assert.match(output, /ACTUAL_REGISTERED_POOL_ADMISSION/u);
  });

  test('runner-only capture keeps its original cutoff when machine policy changes before retry [C7,Q1]', () => {
    queueRun(`
const file=home+'/settings.json';
writeFileSync(file,JSON.stringify({gateSlots:1,browserSlots:1,gate:{runnersOnly:true,runnerWaitMs:80}}));
const captured=gateRunnerAdmission();
assert.equal(captured.runnerOnly,true);
writeFileSync(file,JSON.stringify({gateSlots:1,browserSlots:1,gate:{runnersOnly:false,runnerWaitMs:60000}}));
assert.deepEqual(gateRunnerAdmission(),{},'a later operation sees the new opt-out');
for(const attempt of [1,2]) {
  await assert.rejects(takeResource({...base,...captured,runnerProvider:()=>[],agent:'captured-'+attempt}),
    error=>error.code==='RUNNER_WAIT_DEADLINE' && error.message.includes(new Date(captured.runnerDeadlineAt).toISOString()));
}`);
  });

  test('opt-in native submit uses a real registered worker even with free local capacity [C7,V4]', () => {
    const box = helpers.project('true');
    const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    const requests = join(box.dir, 'runner-only-requests.jsonl');
    installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine, requests });
    box.env.PATH = `${paths.bin}:${box.env.PATH}`;
    succeeded(box.run(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1'));
    const added = succeeded(fixtureAdd(box.run, box.repo, 'web', 'Registered runner-only submission', '--specs', 'G1',
      '--criterion', 'The native frozen check executes in its admitted registered worker.',
      '--check', 'printf RUNNER_ONLY_FROZEN_BODY', '--wait', '--json'));
    const id = JSON.parse(added.out).item.item_id;
    succeeded(box.run(box.web, 'claim', String(id), '--json'));
    const built = helpers.commitFile(box, box.web, 'web/registered.txt', 'actual worker control\n', 'feat(web): registered runner-only control [G1]');
    assert.equal(built.status, 0, built.failure ?? built.stderr);
    succeeded(box.run(box.repo, 'settings', 'gate.runnersOnly', 'on'));
    const settings = JSON.parse(succeeded(box.run(box.repo, 'settings', '--json')).out).settings;
    assert.ok(settings.gateSlots > 0, 'local capacity remains available throughout this control');
    assert.equal(settings.gate.runnersFirst, false, 'runner-only does not depend on runner-first preference');
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const submitted = JSON.parse(succeeded(box.run(box.web, 'submit', String(id), '--wait', '--no-next', '--json')).out);
    const profile = JSON.parse(readFileSync(submitted.gate.check.profilePath, 'utf8'));
    assert.equal(profile.executionRunner, HOST);
    assert.equal(profile.executionSource?.commit, commit);
    assert.equal(profile.receipt?.runner?.id, HOST);
    assert.match(readFileSync(submitted.gate.check.log, 'utf8'), /RUNNER_ONLY_FROZEN_BODY/u);
    const calls = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(calls.length > 0 && calls.every(call => call.host === HOST && call.workerStarted && !call.remoteHasSecret),
      'the actual private SSH stand-in executed the worker; this is no physical-fleet assurance');
  });

  test('native verify reuses its sealed submit proof under either runner policy [C7,V4]', async t => {
    for (const runnersOnly of [true, false]) await t.test(`runner-only ${runnersOnly} [C7,V4]`, child => {
      const { project, item, reviewer, marker } = verificationProject(child, { checked: true });
      assert.equal(readFileSync(marker, 'utf8'), 'check-ran', 'submit executed the real frozen check');
      rmSync(marker, { force: true });
      policy(project, runnersOnly);
      const verified = succeeded(project.run(reviewer, 'verify', String(item), 'accept', '--no-next', '--json'));
      assert.equal(JSON.parse(verified.out).check, 'green');
      assert.equal(existsSync(marker), false, 'the sealed proof requires no new local or remote body');
    });
  });
}

// Budget: each pulled doctrine gate (a submit's offered job, settled by the registered runner) ends well inside the 180 s file kill.
const DOCTRINE_SETTLE_MS = 100_000;

/**
 * Build the registered-worker doctrine project, seeded so a rising count is refused, shared by both doctrine cases [C7].
 * The ssh stand-in is registered after the add and a `runner serve` named for it pulls the item's gates, so each submit
 * offers a job and returns and the case settles it on the job (#10303).
 *
 * @param {import('node:test').TestContext} t - Stops the registered runner when the test ends.
 * @param {{ registerStandInAfterAdd: Function, serveRegisteredRunner: Function }} fixtures - The apps' registered-runner helpers, passed in because gate fixtures never import apps.
 */
async function runnerOnlyDoctrineSetup(t, { registerStandInAfterAdd, serveRegisteredRunner }) {
  const box = helpers.project('true');
  const marker = join(box.dir, 'doctrine-bodies.jsonl');
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  const body = `const fs=require('node:fs'),cp=require('node:child_process');
fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),commit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');
if(fs.readFileSync('web/mode.txt','utf8').trim()==='broken')process.exit(3);
const lines=fs.readFileSync('web/a.txt','utf8').split(/\\r?\\n/).map((line,i)=>line.includes('TODO')?'web/a.txt:'+(i+1)+':'+line:null).filter(Boolean);
if(lines.length)console.log(lines.join('\\n'));
process.exit(lines.length?1:0);
`;
  writeFileSync(join(box.repo, 'bin/doctrine-check.cjs'), body);
  writeFileSync(join(box.repo, 'web/a.txt'), 'TODO old\n');
  writeFileSync(join(box.repo, 'web/mode.txt'), 'count\n');
  appendFileSync(join(box.repo, 'DOCTRINE.md'), '\n## Q · Quality\n- Q7 [approved, must] Web problems only fall. | gate: check node bin/doctrine-check.cjs | count: 1 | files: web\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add private doctrine runner control');
  fixturePolicy(box, { claims: { releaseGone: false, releaseCooldownMinutes: 30, perSeat: 2 } });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const registered = await registerStandInAfterAdd(box, { requests: join(box.dir, 'doctrine-requests.jsonl'), add: () => fixtureAdd(box.run, box.repo, 'web', 'Leased doctrine control', '--specs', 'G1',
    '--criterion', 'The ordinary submission keeps doctrine counts.', '--check', 'true', '--accept-green', 'a fixture check that keeps passing', '--wait', '--json') });
  const id = JSON.parse(succeeded(registered.added).out).item.item_id;
  succeeded(box.run(box.web, 'claim', String(id)));
  succeeded(box.run(box.repo, 'settings', 'gate.runnersOnly', 'on'));
  rmSync(marker, { force: true });
  // A doctrine rise refuses only once its machinery trial has passed (#2611). The ledger is seeded with the identity a
  // RATCHET_ROSE refusal carries and aged past twenty clean gates, so no probe submit pays a registered-runner pipeline (#9241).
  const { checkRulesAt, ratchetMachineryRule } = await import(DOCTRINE);
  const main = box.git(box.repo, 'rev-parse', 'main');
  const rules = checkRulesAt(box.repo, main).filter(rule => rule.runs === 'submit');
  const machinery = ratchetMachineryRule(box.repo, main, rules);
  assert.ok(machinery, 'main has a readable tree to identify the doctrine machinery');
  const ledgerFile = refusalTrialFile(box.repo);
  mkdirSync(dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 2, gates: 20, codes: {
    [trialLedgerKey('RATCHET_ROSE', { rule: ['doctrine', machinery] })]: { code: 'RATCHET_ROSE', start: 0, falseRefusals: 0 } } }) + '\n');
  const runner = await serveRegisteredRunner(t, box, registered);
  return { box, marker, paths: registered.paths, runner, base, id };
}

/**
 * Submit the item from its seat and settle its pulled gate on the registered runner: the submit offers the job and
 * returns, and a refusal (RATCHET_ROSE, RATCHET_UNCOUNTED) is on the settled job's analysis, not in the submit's exit [C7,D1,D3].
 */
async function submitSettled(box, { settledGateJob }, id) {
  succeeded(await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json'));
  return settledGateJob(box, id, { deadlineMs: DOCTRINE_SETTLE_MS });
}

/** The doctrine refusal codes the settled gate job carries. */
function doctrineRefusals(job) {
  return (job.gate?.analysis?.refusals ?? []).filter(row => row.part === 'doctrine').map(row => row.code);
}

/** The doctrine observation receipts the registered runner kept under its cache folder, one parsed record each. */
function doctrineReceipts(runner) {
  return readdirSync(runner.folder, { recursive: true }).filter(name => name.endsWith('observation.json') && name.includes('doctrine'))
    .map(name => JSON.parse(readFileSync(join(runner.folder, name), 'utf8')));
}

/** Install the rising-count case alone: its one registered-worker submit needs a file of its own to stay inside the time budget [C7,D1]. */
export function installRunnerOnlyDoctrineCase(fixtures) {
  test('clause 2: runner-only doctrine refuses a rising count with RATCHET_ROSE in the registered worker [C7,D1,D3]', async t => {
    const { box, id } = await runnerOnlyDoctrineSetup(t, fixtures);
    const roseCommit = helpers.commitFile(box, box.web, 'web/a.txt', 'TODO old\nTODO new\n', 'feat(web): private rising count [G1]');
    assert.equal(roseCommit.status, 0, roseCommit.failure ?? roseCommit.stderr);
    const rose = await submitSettled(box, fixtures, id);
    assert.equal(rose.gate.green, false, JSON.stringify(rose.gate.analysis));
    assert.deepEqual(doctrineRefusals(rose), ['RATCHET_ROSE'], JSON.stringify(rose.gate.analysis));
  });
}

/** Install the uncountable and final green submits alone, with the receipts they bind to the registered worker [C7,D1,D3]. */
export function installRunnerOnlyUncountedCase(fixtures) {
  test('clause 2: runner-only doctrine counts candidate and baseline only in their real registered worker [C7,D1,D3]', async t => {
    const { box, marker, paths, runner, base, id } = await runnerOnlyDoctrineSetup(t, fixtures);
    const brokenCommit = helpers.commitFile(box, box.web, 'web/mode.txt', 'broken\n', 'feat(web): private uncountable control [G1]');
    assert.equal(brokenCommit.status, 0, brokenCommit.failure ?? brokenCommit.stderr);
    const broken = await submitSettled(box, fixtures, id);
    assert.equal(broken.gate.green, false, JSON.stringify(broken.gate.analysis));
    assert.deepEqual(doctrineRefusals(broken), ['RATCHET_UNCOUNTED'], JSON.stringify(broken.gate.analysis));
    writeFileSync(join(box.web, 'web/a.txt'), 'TODO old\nchanged\n');
    writeFileSync(join(box.web, 'web/mode.txt'), 'count\n');
    box.git(box.web, 'add', '-A');
    box.git(box.web, 'commit', '-q', '-m', 'feat(web): preserve private count [G1]');
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const counted = await submitSettled(box, fixtures, id);
    assert.equal(counted.gate.green, true, JSON.stringify(counted.gate.analysis));
    const observations = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(observations.some(row => row.commit === commit), 'candidate command really ran');
    assert.ok(observations.some(row => row.commit === base), `touched existing problem really exercised the baseline command: base ${base}, saw ${JSON.stringify(observations)}`);
    assert.ok(observations.every(row => row.cwd.startsWith(paths.remoteHome + '/')), 'no current or baseline doctrine shell ran on the controller');
    // Main's count is measured once, machine-wide, by the first submit, and its receipt sits in the registered runner's cache.
    const receipts = doctrineReceipts(runner);
    assert.ok(receipts.some(row => row.checkedSource.commit === commit && row.privateCheck.phases.check.code === 1), 'exit one remains a counted current result');
    assert.ok(receipts.some(row => row.checkedSource.commit === base && row.privateCheck.phases.check.code === 1), 'the baseline has its own actual source-bound receipt');
    assert.ok(receipts.some(row => row.privateCheck.phases.check.code === 3), 'the uncountable exit is retained rather than a passing empty count');
    assert.ok(receipts.every(row => row.runner === HOST && row.checkedSource.commit === row.executionSource.commit
      && row.checkedSource.tree === row.executionSource.tree && row.privateCheck.sourceUnchanged), 'all counted observations bind actual unchanged source');
  });
}
