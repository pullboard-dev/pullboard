import { openBoard } from '../../../lib/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  installSshStandIn,
  HOST,
} from '../../tests/fixtures/runner/ssh.js';
/** Real persisted items compare actual Node tests at immutable Git sources [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';

const CASES = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {value} from './value.js';
test('new red case [V4,C7]',()=>assert.equal(value.newRed,true));
test('fixed case [V4,C7]',()=>assert.equal(value.fixed,true));
test('known red case [V4,C7]',()=>assert.equal(value.known,true));
test('skip is no fix [V4,C7]',{skip:value.skip},()=>assert.ok(false));
`;
const RUNNER = `import {run} from 'node:test';
import {relative,sep} from 'node:path';
delete process.env.NODE_TEST_CONTEXT;
const events=run({files:process.argv.slice(2),concurrency:1});
const rows=[];let failed=false;
for await(const event of events){
 if(!['test:pass','test:fail'].includes(event.type)||event.data.details?.type==='suite')continue;
 const {file,name,skip,todo}=event.data;
 if(!file)throw Error('native case event has no file');
 rows.push({file:relative(process.cwd(),file).split(sep).join('/'),name,passed:event.type==='test:pass',skipped:skip!==undefined||todo!==undefined});
 if(event.type==='test:fail')failed=true;
}
process.stdout.write('# pullboard test outcomes '+JSON.stringify({version:1,id:process.env.PULLBOARD_TIMING_RUN_ID,tests:rows})+'\\n');
process.stdout.write('TAP version 13\\n1..'+rows.length+'\\n');
for(const [i,row] of rows.entries())process.stdout.write((row.passed?'ok ':'not ok ')+(i+1)+' - '+row.name+(row.skipped?' # SKIP':'')+'\\n');
process.stdout.write('# tests '+rows.length+'\\n# pass '+rows.filter(row=>row.passed&&!row.skipped).length+'\\n# fail '+rows.filter(row=>!row.passed&&!row.skipped).length+'\\n# skipped '+rows.filter(row=>row.skipped).length+'\\n');
process.exitCode=failed?1:0;
`;

/** Build real Git histories and declare synthetic board lifecycle data without claiming a gate ran. */
async function fixture(t, { missingRunner = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Comparison fixture';
  sandbox.env.TMPDIR = sandbox.dir;
  const box = helpers.project('true', sandbox);
  const worker = join(box.dir, 'worker');
  const workerHome = join(box.dir, 'worker-home');
  const workerMachine = join(box.dir, 'worker-machine');
  for (const path of [worker, workerHome, workerMachine]) mkdirSync(path, { recursive: true });
  // The stand-in worker runs the comparison itself, so its machine settles the way the submitting side does [P7].
  fixtureSettledMachine(workerMachine);
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home: workerHome, machineHome: workerMachine, requests: join(box.dir, 'requests') });
  const registered = await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
  assert.equal(registered.code, 0, registered.out + registered.err);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG,
    gate: 'true', affectedTests: 'node web/runner.js' }));
  if (!missingRunner) writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value={newRed:true,fixed:false,known:false,skip:false};\n');
  writeFileSync(join(box.repo, 'web/a space.test.js'), CASES);
  writeFileSync(join(box.repo, 'web/journey.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {value} from './value.js';test('deferred journey [V4,C7]',()=>{void value;assert.equal(spawnSync('false').status,0)});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: comparison base [G1]');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Comparison fixture', '--specs', 'G1', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(id, 1);
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  return { ...box, helpers, id, base };
}

/** Record the exact submitted source through the existing explicitly synthetic lifecycle helper. */
function submit(box) {
  const commit = box.helpers.attackCommit(box, box.web);
  box.git(box.web, 'update-ref', `refs/pullboard/items/${box.id}/${commit.slice(0, 12)}`, commit);
  // @pullboard-board-file journey: subsequent real CLI processes read this explicitly synthetic lifecycle move.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  board.gitRoot = box.repo; // Bind the real committed policy exactly as the native CLI does.
  try { submitFixture(board, box.id, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', `${commit}^{tree}`) }); }
  finally { closeBoard(board); }
  return commit;
}

/** Execute the public diagnostic and check its durable execution identities and unchanged item state. */
async function compare(box) {
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: box.env, timeout: 120000 }); // budget: real private comparison subprocess ceiling.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const compared = JSON.parse(result.stdout);
  for (const [side, run] of Object.entries({ head: compared.head, base: compared.base })) {
    if (!run.files.length) { assert.equal(run.id, null); continue; }
    assert.match(run.id, /^[a-f0-9-]{36}$/u);
    const recorded = JSON.parse(readFileSync(join(box.repo, '.git/pullboard/check-output', `compare-${run.id}.json`), 'utf8'));
    assert.equal(recorded.commit, compared[side + 'Commit']);
    assert.ok(readFileSync(recorded.profileFile, 'utf8').length > 0);
  }
  const shown = await box.runLocal(box.repo, 'show', String(box.id), '--json');
  assert.equal(JSON.parse(shown.out).item_status, 'submitted', 'comparison never gives a verdict');
  return compared;
}

test('verify --compare selects importing tests and reports only new reds and actual fixes [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:true};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.headCommit, head);
  assert.equal(result.baseCommit, box.base);
  assert.deepEqual(result.files, ['web/a space.test.js']);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(result.fallback, null);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});

test('verify --compare treats an added test file as new and does not execute its missing base path [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/added.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './value.js';test('added red [V4,C7]',()=>assert.equal(value.newRed,false));\n");
  submit(box);
  const result = await compare(box);
  assert.deepEqual(result.newFiles, ['web/added.test.js']);
  assert.deepEqual(result.base.files, []);
  assert.deepEqual(result.newRed.map(row => row.name), ['added red [V4,C7]']);
  assert.equal(result.fallback, null);
});

test('verify --compare falls back from an unrunnable base to composed head versus main [V4,C7]', async t => {
  const box = await fixture(t, { missingRunner: true });
  writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  box.git(box.repo, 'add', 'web/runner.js');
  box.git(box.repo, 'commit', '-qm', 'fix: provide current runner [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:false};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.fallback.base, box.base);
  assert.equal(result.baseCommit, main);
  assert.notEqual(result.headCommit, head);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});

test('a green submission records its background comparison without a reviewer command [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:true,fixed:true,known:true,skip:true};\n');
  const head = box.helpers.attackCommit(box, box.web);
  const result = await runFixtureChildAsync(process.execPath, [box.helpers.BIN, 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, timeout: 120000 }); // budget: real private comparison subprocess ceiling.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  let comparison, thread;
  // budget: bounded wait for real private runner completion; never an elapsed-time assertion.
  await box.helpers.waitFor(async () => { // budget: hang ceiling for actual background runner completion.
    const shown = await box.runLocal(box.repo, 'show', String(box.id), '--json');
    assert.equal(shown.code, 0, shown.err);
    const item = JSON.parse(shown.out);
    assert.equal(item.item_status, 'submitted');
    comparison = item.comparison; thread = item.thread;
    if (comparison?.status === 'unavailable') assert.fail(JSON.stringify(comparison));
    return comparison?.status === 'complete';
  }, 'automatic comparison result', 120000); // budget: real private SSH workers, parallel immutable sources, no elapsed-time assertion.
  assert.ok(thread.some(entry => entry.type === 'fact' && entry.text.includes('\"status\":\"pending\"')), 'submit records pending before its detached comparison');
  assert.equal(comparison.source, head);
  assert.deepEqual(comparison.newRed, []);
  assert.ok(comparison.head.id && comparison.base.id);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  const joined = fixtureJoin(box.run, reviewer, 'api', '--model', 'Comparison reviewer', '--json');
  assert.equal(joined.code, 0, joined.err);
  const offered = await box.runLocal(reviewer, 'next', '--verify', '--json');
  assert.equal(offered.code, 0, offered.err);
  assert.equal(JSON.parse(offered.out).comparison.status, 'complete');
});


test('an empty configured runner pool records an unavailable comparison without dispatch [C7,V4]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:true,fixed:true,known:true,skip:true};\n');
  const head = submit(box);
  const removed = await box.runLocal(box.repo, 'runner', 'remove', HOST, '--json');
  assert.equal(removed.code, 0, removed.out + removed.err);
  const requests = join(box.dir, 'requests');
  const before = existsSync(requests) ? readFileSync(requests, 'utf8') : '';
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: box.env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const comparison = JSON.parse(result.stdout);
  assert.equal(comparison.status, 'unavailable');
  assert.equal(comparison.source, head);
  assert.match(comparison.error, /no configured runner/u);
  const shown = await box.runLocal(box.repo, 'show', String(box.id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.equal(JSON.parse(shown.out).comparison.status, 'unavailable', 'the ordinary diagnostic records its unavailable fact');
  assert.equal(existsSync(requests) ? readFileSync(requests, 'utf8') : '', before, 'no worker dispatch was attempted');
});
