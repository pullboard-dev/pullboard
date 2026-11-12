import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
/** A review comparison hands commit ids to the runner and makes no checkout, clone or worktree on the coordinator [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../tests/fixtures/testkit.js';
import { withFixtureBoard } from '../../../tests/fixtures/testkit.js';

const CASES = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {value} from './value.js';
test('new red case [V4,C7]',()=>assert.equal(value.newRed,true));
test('fixed case [V4,C7]',()=>assert.equal(value.fixed,true));
test('known red case [V4,C7]',()=>assert.equal(value.known,true));
test('skip is no fix [V4,C7]',{skip:value.skip},()=>assert.ok(false));
`;
const RUNNER = `import {run} from 'node:test';
import { relative } from 'node:path';
import { sep } from 'node:path';
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
  sandbox.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  sandbox.env.TMPDIR = sandbox.dir;
  const box = helpers.project('true', sandbox);
  const worker = join(box.dir, 'worker');
  const workerHome = join(box.dir, 'worker-home');
  const workerMachine = join(box.dir, 'worker-machine');
  for (const path of [worker, workerHome, workerMachine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home: workerHome, machineHome: workerMachine, requests: join(box.dir, 'requests') });
  const registered = await box.runIn(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '0', '--json');
  assert.equal(registered.code, 0, registered.out + registered.err);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  fixtureProjectPolicy(box.repo, { config: { ...helpers.CONFIG, gate: 'true', affectedTests: 'node web/runner.js' } });
  if (!missingRunner) writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value={newRed:true,fixed:false,known:false,skip:false};\n');
  writeFileSync(join(box.repo, 'web/a space.test.js'), CASES);
  writeFileSync(join(box.repo, 'web/journey.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {value} from './value.js';test('deferred journey [V4,C7]',()=>{void value;assert.equal(spawnSync('false').status,0)});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: comparison base [G1]');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Comparison fixture', '--specs', 'G1', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(id, 1);
  assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0);
  return { ...box, helpers, id, base };
}

/** Record the exact submitted source through the existing explicitly synthetic lifecycle helper. */
function submit(box) {
  const commit = box.helpers.attackCommit(box, box.web);
  box.git(box.web, 'update-ref', `refs/pullboard/items/${box.id}/${commit.slice(0, 12)}`, commit);
  // @pullboard-board-file journey: subsequent real CLI processes read this explicitly synthetic lifecycle move.
  withFixtureBoard(join(box.repo, '.git/pullboard/board.sqlite'), board => {
    board.gitRoot = box.repo; // Bind the real committed policy exactly as the native CLI does.
    submitFixture(board, box.id, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', `${commit}^{tree}`) });
  });
  return commit;
}


/**
 * Put a recording git in front of the real one for a single child process and return the file it logs to.
 * Why: the claim is about what the coordinator runs, so it is read from the commands themselves.
 */
function gitSpy(box) {
  const directory = join(box.dir, 'git-spy'), log = join(box.dir, 'git-spy.log');
  mkdirSync(directory, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: box.env }).trim();
  writeFileSync(join(directory, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(directory, 'git'), 0o755);
  return { env: { ...box.env, PATH: `${directory}:${box.env.PATH}` }, log };
}

test('clause 1: verify --compare sends both commit ids to the runner and makes no clone, checkout or worktree here [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:true};\n');
  const head = submit(box);
  const spy = gitSpy(box);
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: spy.env, timeout: 120000 }); // budget: real private comparison subprocess ceiling.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const compared = JSON.parse(result.stdout);
  assert.equal(compared.headCommit, head);
  assert.equal(compared.baseCommit, box.base);
  assert.deepEqual(compared.files, ['web/a space.test.js']);
  assert.deepEqual(compared.newRed.map(row => row.name), ['new red case [V4,C7]']);
  // Each side ran on the runner at the exact commit it was handed, read from the object store.
  for (const [side, commit] of [['head', head], ['base', box.base]]) {
    const recorded = JSON.parse(readFileSync(join(box.repo, '.git/pullboard/check-output', `compare-${compared[side].id}.json`), 'utf8'));
    assert.equal(recorded.commit, commit);
    const profile = JSON.parse(readFileSync(recorded.profileFile, 'utf8'));
    assert.equal(profile.executionRunner, HOST);
    assert.equal(profile.executionSource?.commit, commit);
  }
  const calls = readFileSync(join(box.dir, 'requests'), 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(calls.length > 0 && calls.every(call => call.host === HOST), 'every request went to the registered runner');
  assert.ok(existsSync(spy.log), 'the spy saw the comparison run its git commands');
  const commands = readFileSync(spy.log, 'utf8').split('\n').filter(Boolean);
  assert.ok(commands.some(line => /\brev-parse\b/u.test(line.split('\t')[1])), 'the spy records real calls');
  // The ssh stand-in runs the runner's own git beside this one; only commands in this machine's folders count here.
  const runnerSide = [join(box.dir, 'worker'), join(box.dir, 'pullboard-committed-runner-')];
  const local = commands.map(line => line.split('\t')).filter(([cwd]) => !runnerSide.some(prefix => cwd.startsWith(prefix)))
      .map(([, args]) => args).filter(args => !args.includes('pullboard-committed-runner-')).filter(args => /(?:^|\s)(?:clone|checkout|read-tree|archive)(?:\s|$)|\bworktree add\b/u.test(args));
  assert.deepEqual(local, [], 'no checkout, clone or worktree was made on the coordinator');
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});
