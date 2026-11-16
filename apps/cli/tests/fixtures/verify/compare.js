/** Real Git histories, an SSH stand-in worker and the public comparison command for the verify --compare journeys [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBoard } from '../../../../lib/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { submitFixture } from '../board/submit.js';
import { installSshStandIn } from '../runner/ssh.js';
import { startFixtureLocalRunner } from '../runner/local-start.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';
import { HOST } from '../runner/ssh.js';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChildAsync } from '../child.js';
import { fixtureAdd } from '../testkit.js';
import { fixtureSettledMachine } from '../testkit.js';

export const CASES = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {value} from './value.js';
test('new red case [V4,C7]',()=>assert.equal(value.newRed,true));
test('fixed case [V4,C7]',()=>assert.equal(value.fixed,true));
test('known red case [V4,C7]',()=>assert.equal(value.known,true));
test('skip is no fix [V4,C7]',{skip:value.skip},()=>assert.ok(false));
`;
export const RUNNER = `import {run} from 'node:test';
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
export async function fixture(t, { missingRunner = false } = {}) {
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
  fixtureSettledMachine(workerMachine);
  // The registered host only makes the pool non-empty (comparison needs a configured runner); a real local runner, never
  // a child of this test, pulls and runs the comparison's jobs [P7,#7185].
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home: workerHome, machineHome: workerMachine, requests: join(box.dir, 'requests') });
  const registered = await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
  assert.equal(registered.code, 0, registered.out + registered.err);
  startFixtureLocalRunner(box.env, box.repo);
  t.after(() => stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME));
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
export function submit(box) {
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
export async function compare(box) {
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: box.env, timeout: 120000 }); // budget: real private comparison subprocess ceiling.
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log');
  assert.equal(result.status, 0, result.stdout + result.stderr + '\nlocal runner log:\n' + (existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : '(none)'));
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
