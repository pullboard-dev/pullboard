/** @pullboard-test-input packages/resources/index.js */
/** @pullboard-test-loads packages/resources/index.js */
/** An owned source-advance controller cannot strand capacity after its exact incarnation disappears [C7,P3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { registerRunnerJobLostTests } from '../../tests/fixtures/runner/lost.js';
import { registerControllerDispositionTests } from '../../tests/fixtures/disposition.js';
import { registerRunnerUnavailableRedispatchTests } from '../../tests/fixtures/runner/redispatch.js';

for (const scenario of ['controller exits', 'source deleted', 'live controller', 'foreign record', 'unknown observation']) {
test(`source-advance custody ${scenario} preserves exact cleanup authority [C7,P3]`, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const source = join(box.dir, 'pullboard-source-advance-fixture', 'source');
  mkdirSync(join(box.dir, 'pullboard-source-advance-fixture'));
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', source, 'main');
  const resources = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
  const custodian = `
    import { controllerDeadline } from ${JSON.stringify(resources)};
    let input = '', custody;
    const read = bytes => {
      input += bytes;
      const end = input.indexOf('\\n');
      if (end < 0) return;
      process.stdin.removeListener('data', read);
      const request = JSON.parse(input.slice(0, end));
      custody = controllerDeadline(request.owner, request.parent, request.root);
      process.stdout.write('ready\\n');
    };
    process.stdin.on('data', read);
    process.stdin.on('end', () => custody?.close());
  `;
  const script = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { takeResource, listResources, runnerLeaseHealth, runnerResourceStatus } from ${JSON.stringify(resources)};
    const root = ${JSON.stringify(source)}, scenario = ${JSON.stringify(scenario)};
    const runner = { host: 'source-custody-fixture.invalid', slots: 1, browser: 1 };
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, {recursive:true});
    const lease = await takeResource({name:'gate',capacity:0,scope:'machine',root,repo:root,
      agent:'coordinator',item:'2055',kind:'submit',remote:true,runnerOnly:true,
      runnerWaitMs:5000,runnerProvider:()=>[runner]});
    const child = spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(custodian)}],
      {env:process.env,stdio:['pipe','pipe','pipe']});
    const closed = new Promise(resolve=>child.once('close',resolve));
    let errors = '';
    child.stderr.on('data',bytes=>{errors+=bytes;});
    let timer, psRefusals = 0;
    const originalPs = cp.execFileSync;
    try {
      const ready = new Promise((resolve,reject)=>{
        child.stdout.once('data',resolve);
        child.once('error',reject);
        child.once('exit',()=>reject(new Error('custodian exited before readiness: '+errors)));
        timer=setTimeout(()=>reject(new Error('custodian readiness did not arrive: '+errors)),5000);
      });
      child.stdin.write(JSON.stringify({owner:{token:lease.token,pool:lease.pool},parent:process.pid,root})+'\\n');
      await ready; clearTimeout(timer);
      const directory=join(process.env.PULLBOARD_MACHINE_HOME,'controller-deadlines');
      const files=readdirSync(directory).filter(file=>file.endsWith('.json'));
      assert.equal(files.length,1,'even an unbounded healthy controller records custody');
      const file=join(directory,files[0]), original=readFileSync(file,'utf8');
      const record=JSON.parse(original);
      assert.equal(record.controllerPid,child.pid);
      assert.equal(record.holderPid,process.pid);
      assert.ok(record.holderStarted && record.started);
      assert.equal(record.source.root,root);
      if(scenario==='controller exits') {
        child.kill('SIGKILL'); await closed;
      }
      if(scenario==='source deleted') rmSync(root,{recursive:true});
      if(scenario==='foreign record') writeFileSync(file,JSON.stringify({...record,started:{untrusted:'another incarnation'}}));
      if(scenario==='unknown observation') {
        cp.execFileSync=function(command,args,...options) {
          if(command==='/bin/ps' && args.includes(String(child.pid))) {
            psRefusals++;
            throw Object.assign(new Error('private observation unavailable'),{code:'EPERM'});
          }
          return Reflect.apply(originalPs,this,[command,args,...options]);
        };
        syncBuiltinESMExports();
      }
      const orphan=scenario==='controller exits' || scenario==='source deleted';
      const health=runnerLeaseHealth();
      assert.equal(health.length,orphan?1:0,'read-only health names a proven orphan without changing capacity');
      const db=new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME,'resources.sqlite'),{readOnly:true});
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder').get().n,1,'health must retain the holder');
        listResources();
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holder').get().n,orphan?0:1);
        // A dead controller leaves its healthy host in service and requeues (#3248); a lost source is still unverified cleanup.
        const requeued=scenario==='controller exits';
        const recorded=requeued?'orphan-requeued':'cleanup';
        const cleanup=db.prepare("SELECT detail FROM runner_recovery_event WHERE kind IN ('cleanup','orphan-requeued')").all();
        assert.equal(cleanup.length,orphan?1:0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_recovery_event WHERE kind=?').get(orphan?recorded:'cleanup').n,orphan?1:0);
        if(orphan) {
          const detail=JSON.parse(cleanup[0].detail);
          assert.equal(detail.cause,scenario==='controller exits'?'controller process is gone':'source directory is gone');
          assert.equal(detail.controllerPid,child.pid);
          assert.equal(detail.remoteCleanup,'unknown','local absence is never remote cleanup proof');
          const status=runnerResourceStatus([runner])[0];
          assert.equal(status.inUse,0);
          if(requeued) {
            assert.equal(status.unavailable,false,'a dead controller does not quarantine its healthy host');
            assert.equal(status.unavailableReason,undefined);
          } else assert.equal(status.unavailableReason,'CLEANUP_UNVERIFIED');
          listResources();
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_recovery_event WHERE kind IN ('cleanup','orphan-requeued')").get().n,1,'cleanup is idempotent');
        }
      } finally {db.close();}
      if(scenario==='unknown observation') assert.ok(psRefusals>0,'unknown observation was actually exercised');
      console.log(JSON.stringify({scenario,orphan,healthProblems:health.map(row=>row.problem)}));
    } finally {
      clearTimeout(timer);
      cp.execFileSync=originalPs; syncBuiltinESMExports();
      if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      await closed;
      lease.release();
    }
  `;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).scenario, scenario);
});
}

registerRunnerJobLostTests();
registerControllerDispositionTests();

registerRunnerUnavailableRedispatchTests();
