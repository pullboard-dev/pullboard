/** @pullboard-test-input source-tree */
/** Real private runner dispatch and public status under controlled memory readings [C7]. */
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';
import {
  HOST,
  installSshStandIn,
} from './ssh.js';

/** Run the actual gate and worker with the existing memory-reader seam in a private machine home. */
export async function assertRunnerMemoryAdmission() {
  const e2e = createE2eHelpers();
  try {
    const box = e2e.project('true');
    const bin = join(box.dir, 'runner-bin');
    const worker = join(box.dir, 'runner-worker');
    const home = join(box.dir, 'runner-home');
    const requests = join(box.dir, 'runner-requests.jsonl');
    for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
    installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
    box.env.PATH = `${bin}:${box.env.PATH}`;
    assert.equal(box.run(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1').code, 0);
    for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '1'], ['gateSlots', '1']]) {
      const changed = box.run(box.repo, 'settings', key, value);
      assert.equal(changed.code, 0, changed.err);
    }
    // The existing floor is file-configured; its CLI setter is not part of this item.
    const settingsPath = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Pull dispatch is the default; this probe drives the gate slot and runner worker directly.
    writeFileSync(settingsPath, JSON.stringify({ ...settings, gate: { ...settings.gate, memoryFloorMB: 512 } }));
    writeFileSync(join(box.repo, 'memory-probe.cjs'), "console.log('REAL_RUNNER_MEMORY_PROBE');\n");
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: private memory admission probe');
    const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/heavy.js')).href;
    const cli = join(import.meta.dirname, '../../../pullboard.js');
    const source = [
      `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}`,
      "import {execFileSync} from 'node:child_process';",
      "import {DatabaseSync} from 'node:sqlite';",
      `import {runOnRunnerAsync,probeRunnerHealth} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/runners/index.js')).href)};`,
      `import {listResources,recordRunnerFailure,recoverUnavailableRunners} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href)};`,
      "import {readdirSync,readFileSync} from 'node:fs';",
      'const root=process.cwd(); const output={};',
      `const runner=${JSON.stringify(settings.runners[0])};`,
      'const completed=await runOnRunnerAsync(root,"true",{runner,metadata:{item:"fixture",kind:"remote-command"}});if(!completed.isGreen)throw new Error("preparatory worker did not complete");',
      `const recoveryDirectory=${JSON.stringify(join(home, '.pullboard-runner', 'recovery'))};`,
      'const completion=JSON.parse(readFileSync(recoveryDirectory+"/"+readdirSync(recoveryDirectory)[0],"utf8"));',
      'listResources();const recoveredQueue=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+"/resources.sqlite");',
      'recordRunnerFailure(recoveredQueue,runner.host,"transport-lost",{recovery:completion});',
      'output.prepared=await recoverUnavailableRunners(recoveredQueue,[runner],{probe:probeRunnerHealth,now:Date.now()+2000});recoveredQueue.close();',
      'if(!output.prepared)throw new Error("preparatory exact-worker recovery did not complete");',
      '/** Keep the refusal path bounded: release only the private simulated pressure after observing it. */',
      'async function exercise(remote, agent, releaseOccupied){',
      'let recovered=false; const held=[]; let status=null; let runnerStatus=null; let waited=0;',
      'const readMemory=async()=>({checked:true,platform:process.platform,pressure:recovered?"normal":"critical",',
      'availableBytes:(recovered?8192:64)*1024**2,totalBytes:16*1024**3,processes:[]});',
      'const result=await withGateSlot(root,lease=>runProfiledShellAsync(root,"node memory-probe.cjs",{gateLease:lease,waitMs:lease.waitMs}),',
      '{executionServices,remote,agent,kind:"focused",readMemory,onWait(state){waited+=1;',
      `status=JSON.parse(execFileSync(process.execPath,[${JSON.stringify(cli)},"status","--json"],{cwd:root,encoding:"utf8"}));`,
      `runnerStatus=JSON.parse(execFileSync(process.execPath,[${JSON.stringify(cli)},"resources","--json"],{cwd:root,encoding:"utf8"})).runners.find(row=>row.host===${JSON.stringify(HOST)});`,
      'if(state.memory?.held){held.push(state.memory);recovered=true;} releaseOccupied?.();}});',
      'return {green:result.isGreen,runner:result.executionRunner,output:result.output,held,status,runnerStatus,waited};}',
      'let markOccupied,releaseOccupied;',
      'const ready=new Promise(resolve=>{markOccupied=resolve;});',
      'const release=new Promise(resolve=>{releaseOccupied=resolve;});',
      'const occupied=withGateSlot(root,async lease=>{if(!lease.runner)throw new Error("occupying run did not reserve a runner");markOccupied();await release;},',
      '{executionServices,agent:"occupied-runner",kind:"focused",readMemory:async()=>({checked:true,pressure:"normal",availableBytes:8*1024**3,totalBytes:16*1024**3,processes:[]})});',
      'await Promise.race([ready,occupied.then(()=>{throw new Error("occupying run ended before the queue control");})]);',
      '// The actually recovered host remains compatible while its real slot is occupied.',
      'try{output.remote=await exercise(true,"remote-memory-control",releaseOccupied);}finally{releaseOccupied();await occupied;}',
      'output.local=await exercise(false,"local-memory-control");',
      'console.log(JSON.stringify(output));',
    ].join('\n');
    const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(run.status, 0, run.failure || run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.prepared, true, 'the host was actually recovered using exact completed-worker custody');
    assert.equal(result.remote.green, true, result.remote.output);
    assert.equal(result.remote.runner, HOST, 'the actual stand-in worker executed this run');
    assert.match(result.remote.output, /REAL_RUNNER_MEMORY_PROBE/u);
    assert.deepEqual(result.remote.held, [], 'a runner-bound run is never held for local memory');
    assert.equal(result.remote.runnerStatus.unavailable, false, 'public resources agrees the actually recovered host is available');
    assert.ok(result.remote.waited > 0, 'the compatible runner was genuinely occupied before the real dispatch');
    assert.ok(!result.remote.status.memoryHeld.some(entry => entry.agent === 'remote-memory-control'), 'a capacity-blocked remote run is not listed as memory-held');
    assert.equal(result.local.green, true, result.local.output);
    assert.ok(result.local.held.length > 0, 'local-only work still waits for recovery');
    assert.ok(result.local.status.memoryHeld.some(entry => entry.agent === 'local-memory-control'), 'public status names the actual locally held run');
    assert.ok(!result.local.status.memoryHeld.some(entry => entry.agent === 'remote-memory-control'), 'status does not falsely label the finished runner-bound run');
  } finally { e2e.cleanup(); }
}
