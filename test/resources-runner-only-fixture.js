/** Private native queue and CLI controls for opt-in submit/review runner-only admission [C7,Q1]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';

const RESOURCES = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const SETTINGS = pathToFileURL(resolve(import.meta.dirname, '../src/settings.js')).href;
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
  assert.equal(result.code, 0, result.err || result.out);
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

  test('native submit runner-only refuses before its frozen body and opt-out still executes it [C7,V4]', () => {
    const box = helpers.project('true');
    const marker = join(box.dir, 'submit-frozen-body');
    const command = `printf ran > '${marker.replaceAll("'", "'\\''")}'`;
    const added = succeeded(box.run(box.repo, 'add', 'web', 'Private runner-only submission', '--specs', 'G1',
      '--criterion', 'The native frozen check remains mandatory.', '--check', command, '--wait', '--json'));
    const id = JSON.parse(added.out).item.item_id;
    succeeded(box.run(box.web, 'claim', String(id), '--json'));
    const committed = helpers.commitFile(box, box.web, 'web/runner-only.js', 'export const ready = true;\n', 'feat(web): private runner-only control [G1]');
    assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
    // Native bar baseline setup may itself have run the command; it is not the subject submission.
    rmSync(marker, { force: true });
    policy(box, true);
    const refused = box.run(box.web, 'submit', String(id), '--no-next', '--json');
    assert.notEqual(refused.code, 0, refused.out);
    assert.equal(JSON.parse(refused.out).error.code, 'RUNNER_WAIT_DEADLINE', refused.err || refused.out);
    assert.equal(existsSync(marker), false, 'no frozen or diagnostic local body ran');
    policy(box, false);
    succeeded(box.run(box.web, 'submit', String(id), '--no-next', '--json'));
    assert.equal(readFileSync(marker, 'utf8'), 'ran', 'opt-out still runs the actual frozen check');
  });

  test('native verify runner-only refuses before the actual check and opt-out still verifies [C7,V4]', t => {
    const { project, item, reviewer, marker } = verificationProject(t, { checked: true });
    rmSync(marker, { force: true });
    policy(project, true);
    const refused = project.run(reviewer, 'verify', String(item), 'accept', '--no-next', '--json');
    assert.notEqual(refused.code, 0, refused.out);
    assert.equal(JSON.parse(refused.out).error.code, 'RUNNER_WAIT_DEADLINE', refused.err || refused.out);
    assert.equal(existsSync(marker), false, 'the review check and guard diagnostics cannot execute locally');
    policy(project, false);
    succeeded(project.run(reviewer, 'verify', String(item), 'accept', '--no-next', '--json'));
    assert.equal(readFileSync(marker, 'utf8'), 'check-ran');
  });
}
