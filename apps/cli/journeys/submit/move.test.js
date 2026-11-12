/** Foreground and queued submits survive an unrelated main move during their check; any pullboard.json policy change still refuses [V4,H16,C7]. */
import { trialLedgerKey } from '../../../../packages/gate/index.js';
import {
  composeAfterProof,
  requireSubmitComposition,
} from '../../../../packages/items/index.js';
import { handoffRecord } from '../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { gateSettled } from '../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../tests/fixtures/submit/handoff.js';

/** Read the fixture item's durable status and submitted commit. */
function item(box) {
  return state(box).item;
}

/** Read the fixture item and its queued submit job, if any, without writing the board. */
function state(box) {
  // @pullboard-board-file journey: the real CLI owns every queue, submission and verdict write.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return { job: handoffRecord(db, box.id) ?? null,
      item: db.prepare('SELECT item_status,item_commit,item_verdict FROM item WHERE item_id=?').get(box.id) };
  } finally { db.close(); }
}

/** Read the queued worker's own log so a stalled worker names its cause. */
function workerLog(box, job) {
  const log = join(box.repo, '.git/pullboard/submit-handoffs', job?.id ?? 'none', 'worker.log');
  return existsSync(log) ? readFileSync(log, 'utf8').slice(-1500) : 'no worker log';
}

/**
 * Wait until the queued job has removed what it owns: its source checkout and, for a private tool copy, that copy.
 * A clean checkout's tools snapshot is keyed by the tooling tree and shared by every later submit (#3339), so it
 * stays by design and the job leaves it in place.
 */
async function ownedCleanup(helpers, box, jobId) {
  const directory = join(box.repo, '.git/pullboard/submit-handoffs', jobId);
  const request = join(directory, 'request.json');
  await helpers.waitFor(() => existsSync(request) && !existsSync(join(directory, 'source')), // budget: owned worker cleanup hang ceiling; no throughput claim.
    'owned queued worker source cleanup', 120000); // budget: owned-child hang ceiling, no elapsed-time assertion.
  const tools = JSON.parse(readFileSync(request, 'utf8')).tools;
  if (/^pullboard-handoff-tools-[0-9a-f]+$/u.test(basename(tools))) assert.ok(existsSync(tools), 'the shared tools snapshot stays for the next submit');
  else await helpers.waitFor(() => !existsSync(tools), 'owned queued worker private tooling cleanup', 120000); // budget: owned-child hang ceiling, no elapsed-time assertion.
}

/**
 * Put both composition rules past their trial, the way twenty clean real gates would: MAIN_NOT_COMPOSED is a trial
 * refusal that only reports until then, and each rule keeps its own trial under the one code.
 */
function enforceCompositionRules(box) {
  const file = join(box.repo, '.git/pullboard/refusal-trials.json');
  const codes = {};
  for (const rule of [requireSubmitComposition, composeAfterProof]) {
    const options = { rule: ['composition', rule.toString()] };
    codes[trialLedgerKey('MAIN_NOT_COMPOSED', options)] = { code: 'MAIN_NOT_COMPOSED', identity: 'seeded', start: 0, falseRefusals: 0 };
  }
  assert.equal(Object.keys(codes).length, 2, 'each rule keeps its own trial under one code');
  mkdirSync(join(box.repo, '.git/pullboard'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 2, gates: 20, codes }) + '\n');
}

/**
 * Build a claimed candidate whose frozen check commits to main once while it runs, the way a landing
 * does during a builder's long check (#2181, #2326). `handoff` queues the submit in the fixture's own policy.
 */
async function fixture(t, mode, handoff = false) {
  // The landing is another lane's module no test imports; the check builds its path from pieces so selection never sees a read.
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture Model';
  sandbox.env.TMPDIR = sandbox.dir;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete sandbox.env[key];
  const box = helpers.project('true', sandbox);
  t.after(async () => {
    // A queued gate's driver and dispatcher still write for a moment after its job ends; remove the tree once they are done.
    try { if (handoff && box.id) await gateSettled(helpers, box, state(box).job?.id); }
    finally { await removeSandboxes(helpers); }
  });
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  const marker = join(box.dir, 'main-moved');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature='base';\n");
  writeFileSync(join(box.repo, 'test/feature.test.js'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {feature} from '../web/feature.js'; import {execFileSync} from 'node:child_process'; import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const root=${JSON.stringify(box.repo)}, marker=${JSON.stringify(marker)};
test('feature [G1]',()=>{ if(feature==='item' && !existsSync(marker)) {
  if (${JSON.stringify(mode)} === 'policy') { const f=root+'/pullboard.json'; const c=JSON.parse(readFileSync(f,'utf8')); c.submit={...c.submit,autoFileMainReds:true}; writeFileSync(f,JSON.stringify(c)); }
  else if (${JSON.stringify(mode)} === 'shared') { const f=root+'/pullboard.json'; const c=JSON.parse(readFileSync(f,'utf8')); c.shared=[...c.shared,'notes/']; writeFileSync(f,JSON.stringify(c)); }
  else { const dir=root+'/'+['ap','i'].join(''); mkdirSync(dir,{recursive:true}); writeFileSync(dir+'/'+['lan','ded'].join('')+'.js','export const landed=true;\\n'); }
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  execFileSync('git',['-C',root,'add','-A'],{env}); execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','core.hooksPath=/dev/null','commit','-qm','chore: land during the check [G1]'],{env});
  writeFileSync(marker,'done'); } assert.equal(feature,'item'); });\n`);
  // A second, independent test keeps the candidate's affected tests narrower than the full suite.
  writeFileSync(join(box.repo, 'web/other.js'), "export const other='independent';\n");
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('other [G1]',()=>assert.equal(other,'independent'));\n");
  writeFileSync(join(box.repo, 'bin/run-tests.js'), "import {spawnSync} from 'node:child_process';const env={...process.env};delete env.NODE_TEST_CONTEXT;const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;\n");
  // The lane builds the check it is claimed against, so it owns the test runner and test files that check names.
  const lanes = { ...helpers.CONFIG.lanes, web: { ...helpers.CONFIG.lanes.web, owns: ['web/', 'bin/run-tests.js', 'test/'] } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, lanes,
    gate: 'node bin/run-tests.js test/feature.test.js', affectedTests: 'node bin/run-tests.js', submit: { handoff } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: foreground submit policy [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Foreground main move', '--specs', 'G1',
    '--criterion', 'The feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  box.id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(box.id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const built = helpers.commitFile(box, box.web, 'web/feature.js', "export const feature='item';\n", 'feat(web): foreground candidate [G1]');
  assert.equal(built.status, 0, built.stderr);
  const ready = await box.runLocal(box.repo, 'bar', 'ready', 'on', '--json');
  assert.equal(ready.code, 0, ready.out + ready.err);
  if (mode === 'policy') enforceCompositionRules(box);
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  // Process-level: the submit under test is a real child process whose check moves main while it runs.
  const result = runFixtureChild(process.execPath, [helpers.BIN, 'submit', String(box.id), '--no-next'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  return { box, helpers, main, marker, result, output: result.stdout + result.stderr };
}

test('foreground submit lands green when unrelated main moves during its check [V4,H16,C7]', async t => {
  const { box, main, marker, result, output } = await fixture(t, 'unrelated');
  assert.ok(existsSync(marker), output);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), main, 'main moved while the check ran');
  assert.doesNotMatch(output, /accepted main changed|NO_POLICY/u);
  assert.equal(result.status, 0, output);
  assert.equal(item(box).item_status, 'submitted', output);
});

test('foreground submit still refuses when pullboard.json policy changes during its check [V4,H16,C7]', async t => {
  const { box, marker, result, output } = await fixture(t, 'policy');
  assert.ok(existsSync(marker), output);
  assert.notEqual(result.status, 0, output);
  // Composition reaches the changed pullboard.json first; the sealed policy check refuses it behind that.
  assert.match(output, /NO_POLICY|MAIN_NOT_COMPOSED/u);
  assert.match(output, /pullboard\.json|submit\.autoFileMainReds/u);
  assert.notEqual(item(box).item_status, 'submitted', output);
});

test('queued submit survives an unrelated main move during its gate and is accepted for landing [V4,H16,C7]', async t => {
  const { box, helpers, main, marker, result, output } = await fixture(t, 'unrelated', true);
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /queued gate/u);
  await helpers.waitFor(() => ['green', 'red', 'incomplete'].includes(state(box).job?.state), // budget: real queued worker completion hang ceiling, no elapsed-time assertion.
    'queued gate completion', 120000) // budget: owned-worker hang ceiling, no throughput claim.
    .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(state(box).job)}\n${workerLog(box, state(box).job)}`); });
  const completed = state(box);
  assert.ok(existsSync(marker), 'main moved while the queued gate ran');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), main, 'main moved while the queued gate ran');
  assert.equal(completed.job.state, 'green', JSON.stringify(completed.job));
  assert.equal(completed.item.item_status, 'submitted', JSON.stringify(completed));
  // A second fixture seat reviews the submitted commit; its accept is the landing-ready verdict.
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, completed.item.item_commit);
  assert.equal((await fixtureJoin(box.runLocal, reviewer, 'api')).code, 0);
  const accepted = await box.runLocal(reviewer, 'verify', String(box.id), 'accept', '--note', 'Ran the frozen check at the queued submission.', '--no-next');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const landed = state(box).item;
  assert.ok(landed.item_verdict === 'ACCEPT' || ['accepted', 'merged'].includes(landed.item_status), JSON.stringify(landed));
  const job = state(box).job;
  await ownedCleanup(helpers, box, job.id);
});

test('queued submit refuses when a non-submit pullboard.json policy field changes during its gate [V4,H16,C7]', async t => {
  const { box, helpers, marker, result, output } = await fixture(t, 'shared', true);
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /queued gate/u);
  await helpers.waitFor(() => ['green', 'red', 'incomplete', 'refused'].includes(state(box).job?.state) || existsSync(join(box.repo, '.git/pullboard/submit-handoffs', state(box).job?.id ?? 'none', 'refusal.json')), // budget: real queued worker completion hang ceiling, no elapsed-time assertion.
    'queued gate result', 120000) // budget: owned-worker hang ceiling, no throughput claim.
    .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(state(box).job)}\n${workerLog(box, state(box).job)}`); });
  const completed = state(box);
  assert.ok(existsSync(marker), 'main changed its shared paths while the queued gate ran');
  assert.notEqual(completed.job.state, 'green', JSON.stringify(completed.job));
  assert.notEqual(completed.item.item_status, 'submitted', JSON.stringify(completed));
  const refusal = readFileSync(join(box.repo, '.git/pullboard/submit-handoffs', completed.job.id, 'refusal.json'), 'utf8');
  assert.match(refusal, /NO_POLICY/u);
  assert.match(refusal, /accepted submit policy changed: shared/u);
  await ownedCleanup(helpers, box, completed.job.id);
});
