/** @pullboard-test-input source-tree */
/** An unpinned run requeued off a lost runner dispatches on another runner without invalid metadata [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { awaitNestedRun } from '../../../index.js';
import { runFixtureChildAsync } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { HOST } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';

/** Reuse the private two-runner resources, settings, Git source, and SSH stand-in from #2657. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-unpinned-requeue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  const env = { PATH: `${paths.bin}:${process.env.PATH}`, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Requeue fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Requeue fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: paths.repo, env });
  writeFileSync(join(paths.repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(paths.repo, 'source.txt'), 'private committed source\n');
  runFixtureGit(['add', '-A'], { cwd: paths.repo, env });
  runFixtureGit(['commit', '-qm', 'test: private unpinned requeue source'], { cwd: paths.repo, env });
  const runners = [HOST, `${HOST}-setup`].map(host => ({ host, slots: 1, browser: 0, node: process.execPath }));
  writeFileSync(join(paths.machine, 'settings.json'), JSON.stringify({ gateSlots: 0, browserSlots: 0, runners }));
  return { directory, ...paths, env, runners };
}

/** Run the native gate providers in one owned child while lending the outer test's own slot. */
async function execute(box, source) {
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env }));
  assert.equal(result.status, 0, result.context + '\n' + result.stdout);
  return result.stdout;
}

test('an unpinned run requeues off a lost runner and dispatches without BAD_RESOURCE_METADATA [C7]', async t => {
  const box = fixture(t);
  const requests = join(box.directory, 'requests.jsonl');
  writeFileSync(join(box.bin, 'package.json'), JSON.stringify({ type: 'module' }));
  installSshStandIn({ bin: box.bin, worker: box.worker, home: box.remoteHome, machineHome: box.remoteMachine, requests });
  const gate = new URL('../../../index.js', import.meta.url).href;
  const output = await execute(box, `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {withGateSlot,runProfiledShell} from ${JSON.stringify(gate)};
import {Refused} from ${JSON.stringify(new URL('../../../../kernel/index.js', import.meta.url).href)};
${executionServicesSource(gate)}
const seen=[],root=process.cwd();
const completed=await withGateSlot(root,async lease=>{
  seen.push(lease.runner.host);
  if(seen.length===2){
    const db=new DatabaseSync(${JSON.stringify(join(box.machine, 'resources.sqlite'))},{readOnly:true});
    try {assert.ok(db.prepare('SELECT host FROM runner_unavailable WHERE host=?').get(seen[0]),'the lost first runner was quarantined');}
    finally {db.close();}
  }
  const result=await runProfiledShell(root,'printf unpinned-runner-retry',{gateLease:lease});
  assert.equal(result.isGreen,true,result.output);
  if(seen.length===1)throw new Refused('RUNNER_JOB_LOST','controlled first-runner loss after dispatch');
  return result;
},{executionServices,remote:true,runnerOnly:true,itemCheck:true,agent:'unpinned-requeue',kind:'submit',item:'fixture',onWait(){}});
// Which registered runner is picked first follows measured load, so only the pair is fixed: one host, then the other.
assert.deepEqual([...seen].sort(),${JSON.stringify(box.runners.map(row => row.host).sort())},'an unpinned retry dispatches to the other registered runner');
assert.equal(completed.profile.executionRunner,seen[1]);
assert.equal(completed.output,'unpinned-runner-retry');
console.log(JSON.stringify({seen,executionRunner:completed.profile.executionRunner,output:completed.output}));
`);
  assert.doesNotMatch(output, /BAD_RESOURCE_METADATA/u);
  const done = JSON.parse(output.trim());
  assert.deepEqual([...done.seen].sort(), box.runners.map(row => row.host).sort());
  assert.deepEqual({ executionRunner: done.executionRunner, output: done.output }, { executionRunner: done.seen[1], output: 'unpinned-runner-retry' });
});
