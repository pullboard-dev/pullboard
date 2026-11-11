/** @pullboard-test-input source-tree */
/** A deleted admitted source stops its real controller before the fixture cleanup signal [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

for (const scenario of ['deleted source', 'terminal item', 'unreadable item status']) {
test(scenario === 'unreadable item status'
  ? 'an unreadable item status keeps the lease and health names why until observation recovers [C7]'
  : `a ${scenario} cancels its controller and releases its actual caller lease without fixture cancellation [C7]`, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  if (scenario !== 'deleted source') {
    const added = fixtureAdd(box.run, box.repo, 'web', 'Controller lifecycle witness', '--specs', 'G1', '--criterion', 'a withdrawn item stops its admitted controller', '--json');
    assert.equal(added.code, 0, added.err || added.out);
  }
  let sourceRoot = box.repo;
  if (scenario === 'unreadable item status') {
    sourceRoot = join(box.dir, 'status-source');
    box.git(box.dir, 'clone', '-q', '--shared', box.repo, sourceRoot);
  }
  const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home'), machineHome = join(home, '.pullboard');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath, hold: 'run' });
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const script = `
    import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { spawnSync } from 'node:child_process';
    import { DatabaseSync } from 'node:sqlite';
    import { withGateSlot } from ${JSON.stringify(gate)};
    import { Refused } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/kernel/index.js')).href)};
    import { runnerLeaseHealth } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href)};
    ${executionServicesSource(gate)}
    const root = ${JSON.stringify(sourceRoot)}, requests = ${JSON.stringify(requests)};
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
      gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnersOnly: true, runnerWaitMs: 30000, runnerDispatch: 'controller' },
      runners: [{ host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 1 }]
    }));
    const cleanup = new AbortController();
    let cleanupTriggered = false;
    const running = withGateSlot(root, async lease => {
      try { return await lease.executionServices.runners.runOnRunnerAsync(root, 'true', {
        runner: lease.runner, source: lease.source, browser: true, signal: cleanup.signal,
        runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata }); }
      catch (error) {
        // This owned cleanup path makes the old-production negative finite, never a passing cancellation.
        if (cleanupTriggered) throw new Refused('RUNNER_SOURCE_CHANGED', 'fixture cleanup stopped a controller that failed to observe its deleted source');
        throw error;
      }
    }, { executionServices, browser: true, remote: true, runnerOnly: true, item: ${JSON.stringify(scenario === 'deleted source' ? '2010' : '1')}, kind: 'orphan-fixture', onWait() {} });
    let settledAlready = false;
    const settled = running.then(value => { settledAlready = true; return { value }; }, error => { settledAlready = true; return { code: error.code, name: error.name, message: error.message }; });
    const boot = Date.now() + 10000;
    while (!existsSync(requests + '.phases') || !readFileSync(requests + '.phases', 'utf8').includes('dispatched')) {
      if (Date.now() > boot) throw new Error('private controller never dispatched its owned SSH child');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), { readOnly: true });
    const before = db.prepare('SELECT pid,started,repo,item,browser FROM holder').all();
    const initialProblems = runnerLeaseHealth().filter(row=>row.problem);
    const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(String.fromCharCode(10))
      .map(line => line.trim().split(/ +/u))
      .filter(row => Number(row[1]) === process.pid && row.slice(2).includes('--pullboard-runner-controller'))
      .map(row => Number(row[0]));
    let observation;
    ${scenario === 'unreadable item status' ? `
    // A controller keeps the board file it already resolved while that file exists [C7,#5535], so status goes
    // unreadable by moving that file aside and pointing the clone at nowhere; both are undone below.
    const boardFile=${JSON.stringify(join(box.repo, '.git', 'pullboard', 'board.sqlite'))};
    renameSync(boardFile,boardFile+'.aside');
    execFileSync('git', ['config','remote.origin.url',${JSON.stringify(join(box.dir, 'missing-origin'))}], {cwd:root,env:process.env});
    let problems;
    const observationDeadline=Date.now()+3000;
    do { problems=runnerLeaseHealth().filter(row=>row.problem); if(problems.length) break; await new Promise(resolve=>setTimeout(resolve,20)); } while(Date.now()<observationDeadline);
    const healthRun=spawnSync(process.execPath,[${JSON.stringify(join(import.meta.dirname, '../../../pullboard.js'))},'health','--json'],{cwd:${JSON.stringify(box.repo)},env:process.env,encoding:'utf8'});
    const health=JSON.parse(healthRun.stdout);
    observation={problems,holders:db.prepare('SELECT pid FROM holder').all(),settledAlready,health,healthStatus:healthRun.status};
    execFileSync('git',['config','remote.origin.url',${JSON.stringify(box.repo)}],{cwd:root,env:process.env});
    renameSync(boardFile+'.aside',boardFile);
    const restoredDeadline=Date.now()+3000;
    while(runnerLeaseHealth().some(row=>row.problem)&&Date.now()<restoredDeadline) await new Promise(resolve=>setTimeout(resolve,20));
    observation.restored=runnerLeaseHealth(); observation.holdersAfterRestore=db.prepare('SELECT pid FROM holder').all();
    ` : ''}
    ${scenario === 'terminal item'
      ? `execFileSync(process.execPath, [${JSON.stringify(join(import.meta.dirname, '../../../pullboard.js'))}, 'withdraw', '1', 'the private lifecycle witness is complete', '--json'], { cwd: root, env: process.env });`
      : 'rmSync(root, { recursive: true, force: true });'}
    // Budget: one-second source observation plus owned SSH close; this timer is failure cleanup only.
    const timer = setTimeout(() => { cleanupTriggered = true; cleanup.abort(); }, 5000);
    const outcome = await settled;
    clearTimeout(timer);
    const after = db.prepare('SELECT pid,item FROM holder').all();
    const unavailable = db.prepare('SELECT host,detail FROM runner_unavailable').all();
    const remainingControllers = children.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    db.close();
    console.log(JSON.stringify({ cleanupTriggered, outcome, before, after, unavailable, remainingControllers, observation, initialProblems, controllerPids: children, callerPid: process.pid }));`;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.dir, env, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.before.length, 1);
  assert.equal(actual.before[0].pid, actual.callerPid);
  assert.equal(actual.before[0].browser, 1);
  assert.equal(actual.controllerPids.length, 1);
  assert.notEqual(actual.controllerPids[0], actual.callerPid);
  assert.equal(actual.initialProblems.length, scenario === 'deleted source' ? 1 : 0, 'a numeric item with no readable initial state stays explicitly unknown');
  assert.equal(actual.cleanupTriggered, false, JSON.stringify(actual));
  assert.equal(actual.outcome.code, 'RUNNER_SOURCE_CHANGED');
  assert.equal(actual.outcome.value, undefined, 'source loss cannot become a green test result');
  assert.deepEqual(actual.after, []);
  assert.deepEqual(actual.remainingControllers, [], 'controller must close before its caller releases the lease');
  assert.deepEqual(actual.unavailable.map(row => ({ ...row })), [{ host: HOST, detail: 'CLEANUP_UNVERIFIED' }], 'unproved remote cleanup cannot silently return host capacity');
  if (scenario === 'unreadable item status') {
    assert.equal(actual.observation.settledAlready, false, 'an unknown status cannot be interpreted as a terminal item');
    assert.equal(actual.observation.problems.length, 1);
    assert.equal(actual.observation.problems[0].pid, actual.callerPid);
    assert.equal(actual.observation.health.runnerLifecycleProblems[0].pid, actual.callerPid);
    assert.equal(actual.observation.healthStatus, 1);
    assert.equal(actual.observation.holders.length, 1, 'status observation failure must retain the real lease');
    assert.deepEqual(actual.observation.restored, []);
    assert.equal(actual.observation.holdersAfterRestore.length, 1, 'restoring observation does not release still-active work');
  }
});
}

test('the read-only lifecycle projection keeps accepted unlanded work active [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), root = join(box.dir, 'projection-repo');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  box.git(root, 'commit', '--allow-empty', '-q', '-m', 'test: private read projection');
  const resource = pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href;
  const script = `import {mkdirSync,readFileSync} from 'node:fs'; import {join} from 'node:path';
    import {DatabaseSync} from 'node:sqlite'; import {runnerItemState} from ${JSON.stringify(resource)};
    const root=${JSON.stringify(root)}, directory=join(root,'.git','pullboard'); mkdirSync(directory);
    const file=join(directory,'board.sqlite'), db=new DatabaseSync(file);
    // This isolated schema tests only the read projection; it records no native board authority or proof.
    db.exec(["CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY,meta_value TEXT); CREATE TABLE item(item_id INTEGER PRIMARY KEY,item_status TEXT,item_merged_commit TEXT);",
      "INSERT INTO board_meta VALUES('board_id','private-projection');",
      "INSERT INTO item VALUES(1,'verified',NULL),(2,'verified','${'a'.repeat(40)}'),(3,'withdrawn',NULL),(4,'claimed',NULL);"].join(' '));
    db.close(); const before=readFileSync(file);
    const rows=[1,2,3,4].map(id=>runnerItemState(root,id));
    console.log(JSON.stringify({rows,unchanged:before.equals(readFileSync(file))}));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.rows.map(row=>row.terminal), [false,true,true,false]);
  assert.equal(actual.unchanged, true, 'the observer cannot write board data');
});

test('health names the actual holder past a declared execution deadline and leaves unbounded runs alone [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const childSource = `import { controllerDeadline } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href)};
    const custody = controllerDeadline(JSON.parse(process.argv[1]), Number(process.argv[2]));
    custody.ready(5); process.stdout.write('ready'); process.stdin.resume();
    process.stdin.once('end', () => custody.close());`;
  const script = `import { writeFileSync } from 'node:fs';
    import { join } from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
    import { withGateSlot } from ${JSON.stringify(gate)};
    import { controllerDeadline, overdueRunnerLeases } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href)};
    ${executionServicesSource(gate)}
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({gateSlots:0,browserSlots:0,
      gate:{runnersFirst:true,runnersOnly:true,runnerWaitMs:30000,runnerDispatch:'controller'},runners:[{host:${JSON.stringify(HOST)},node:${JSON.stringify(process.execPath)},slots:1,browser:1}]}));
    const result = await withGateSlot(${JSON.stringify(box.repo)}, async lease => {
      const unbounded = controllerDeadline(lease.runMetadata.resourceOwner, process.pid);
      unbounded.ready(undefined);
      const before = overdueRunnerLeases(); unbounded.close();
      const child = spawn(process.execPath, ['--input-type=module','-e',${JSON.stringify(childSource)},JSON.stringify(lease.runMetadata.resourceOwner),String(process.pid)],{stdio:['pipe','pipe','pipe']});
      const closed = new Promise(resolve => child.once('close',code => resolve(code)));
      await new Promise((resolve,reject) => { child.stdout.once('data',resolve); child.once('error',reject); });
      let rows;
      const cleanupDeadline = Date.now()+2000;
      do { rows=overdueRunnerLeases(); if(rows.length) break; await new Promise(resolve=>setTimeout(resolve,10)); } while(Date.now()<cleanupDeadline);
      const health=spawnSync(process.execPath,[${JSON.stringify(join(import.meta.dirname, '../../../pullboard.js'))},'health','--json'],{cwd:${JSON.stringify(box.repo)},env:process.env,encoding:'utf8'});
      child.stdin.end(); const childCode=await closed;
      return {before,rows,health:{status:health.status,out:health.stdout,err:health.stderr},childCode,after:overdueRunnerLeases(),holderPid:process.pid};
    },{executionServices,remote:true,runnerOnly:true,item:'2010',kind:'deadline-fixture',onWait(){}});
    console.log(JSON.stringify(result));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.before, [], 'ordinary unbounded work gets no invented deadline');
  assert.equal(actual.rows.length, 1);
  assert.equal(actual.rows[0].pid, actual.holderPid);
  assert.notEqual(actual.rows[0].controllerPid, actual.holderPid);
  assert.equal(actual.health.status, 1, actual.health.err || actual.health.out);
  assert.equal(JSON.parse(actual.health.out).overdueRunnerLeases[0].pid, actual.holderPid);
  assert.equal(actual.childCode, 0);
  assert.deepEqual(actual.after, [], 'closed controller custody disappears before normal lease release');
});
