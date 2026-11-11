/** The CLI lists runner slots from each runner's own measured cores and memory behind gate.measuredSlots [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { cli } from '../../tests/fixtures/runner/tooling.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { runnerResourceStatus } from '../../../../packages/resources/index.js';
import { recordRunnerGui } from '../../../../packages/resources/index.js';
import { recordRunnerMeasurement } from '../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { probeRunnerTransport } from '../../../../packages/runners/index.js';
import { refreshRunnerMeasurements } from '../../../../packages/runners/index.js';
import { RESERVED_MEMORY_MB } from '../../../../packages/runners/index.js';
import { PLAIN_SLOT_MB } from '../../../../packages/runners/index.js';
import { BROWSER_SLOT_MB } from '../../../../packages/runners/index.js';
import { computeRunnerSlots } from '../../../../packages/runners/index.js';
import { effectiveRunners } from '../../../../packages/runners/index.js';

/** A real CLI and real SSH stand-in; only the remote machine's reported size is faked, by a preload. */
function box(t) {
  const directory = realpathSync(mkdtempSync('/tmp/pb-slots-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(['repo', 'worker', 'bin', 'home', 'machine', 'remoteHome', 'remoteMachine']
    .map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const size = join(directory, 'size.json');
  const preload = join(directory, 'size.cjs');
  writeFileSync(size, JSON.stringify({ cores: 10, gb: 16 }));
  writeFileSync(preload, `const os=require('node:os');const fs=require('node:fs');
const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(size)},'utf8'));
os.availableParallelism=()=>read().cores;os.totalmem=()=>read().gb*1024**3;
`);
  const env = { ...process.env, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    PATH: `${paths.bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_PATH', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL',
    'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  writeFileSync(join(paths.machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine,
    requests: join(directory, 'requests.jsonl'), registrationNodeOptions: `--require=${preload}` });
  const run = (...args) => {
    const result = cli(paths.repo, env, ...args);
    assert.equal(result.status, 0, result.context);
    return result;
  };
  return {
    paths, env, directory,
    machineSettings: join(paths.machine, 'settings.json'),
    machineFile: join(paths.machine, 'settings.json'),
    machine(cores, gb) { writeFileSync(size, JSON.stringify({ cores, gb })); },
    run,
    json: (...args) => JSON.parse(run(...args, '--json').stdout),
    list: () => JSON.parse(run('runner', 'list', '--json').stdout).runners[0],
  };
}

test('runner add measures a 10-core 16 GB runner on the runner itself and lists the formula slots [C7]', t => {
  const b = box(t);
  const added = b.json('runner', 'add', HOST).runner;
  assert.equal(added.cores, 10);
  assert.equal(added.memoryMB, 16384);
  assert.equal(added.slots, 9);
  assert.equal(added.browser, 6);
  b.run('settings', 'gate.measuredSlots', 'on');
  const listed = b.list();
  assert.equal(listed.slots, 9);
  assert.equal(listed.computedSlots, 9);
  assert.match(b.run('runner', 'list').stdout, /10 cores, 16384 MB; formula 9 slots, 6 browser; offering 9/u);
});

test('a 2-core runner gets one slot [C7]', t => {
  const b = box(t);
  b.machine(2, 16);
  const added = b.json('runner', 'add', HOST).runner;
  assert.equal(added.slots, 1);
  assert.equal(added.cores, 2);
});

test('a declared --slots count is fixed and overrides the measurement [C7]', t => {
  const b = box(t);
  b.run('settings', 'gate.measuredSlots', 'on');
  const added = b.json('runner', 'add', HOST, '--slots', '4', '--browser', '2').runner;
  assert.equal(added.fixed, true);
  assert.equal(b.list().slots, 4, 'the declared count wins over the measured 9');
  assert.equal(b.list().browser, 2);
  assert.match(b.run('runner', 'list').stdout, /declared count overrides/u);
});

test('a legacy runner takes its measured slots only after runner measure and only with the setting on [C7]', t => {
  const b = box(t);
  writeFileSync(b.machineFile, JSON.stringify({ gateSlots: 1, browserSlots: 1, runners: [{ host: HOST, slots: 4, browser: 2 }] }));
  assert.equal(b.list().slots, 4);
  assert.match(b.run('runner', 'list').stdout, /not measured/u);
  b.run('settings', 'gate.measuredSlots', 'on');
  assert.equal(b.list().slots, 4, 'an unmeasured runner keeps its registered count');
  b.run('runner', 'measure');
  assert.equal(b.list().slots, 9);
  assert.equal(b.list().cores, 10);
  b.machine(4, 16);
  b.run('runner', 'measure', HOST);
  assert.equal(b.list().slots, 3, 'a re-measure follows the runner\'s new size');
  b.run('settings', 'gate.measuredSlots', 'off');
  assert.equal(b.list().slots, 4, 'turning the setting off restores the registered count');
});

/** Scope only this process's private machine provider; every held lease is drained before restoration. */
function useMachine(t, b) {
  const previous = { PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_MACHINE_HOME, PATH: process.env.PATH };
  process.env.PULLBOARD_MACHINE_HOME = b.paths.machine;
  process.env.PATH = b.env.PATH;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('real mixed runner leases stay within measured memory including the reserve [C7]', async t => {
  const b = box(t); useMachine(t, b);
  const measured = { host: HOST, ...computeRunnerSlots({cores:10,memoryMB:16384}) };
  const leases=[];
  const acquire = browser => takeResource({name:'gate',capacity:1,browserCapacityProvider:()=>1,scope:'machine',
    root:b.paths.repo,repo:b.paths.repo,agent:'measured-capacity-fixture',remote:true,runnerOnly:true,browser,
    runnerProvider:()=>[measured]});
  try {
    for(let n=0;n<measured.browser;n++)leases.push(await acquire(true));
    for(let n=measured.browser;n<measured.slots;n++)leases.push(await acquire(false));
    assert.equal(leases.length,9);
    assert.equal(runnerResourceStatus([measured])[0].inUse,9,'actual held machine leases, not simulated test execution');
    const used=RESERVED_MEMORY_MB+leases.reduce((sum,lease)=>sum+(lease.browser?BROWSER_SLOT_MB:PLAIN_SLOT_MB),0);
    assert.ok(used<=16384,`held mixture requires ${used} MB including the reserve`);
  } finally { for(const lease of leases.reverse())lease.release(); }
});

test('periodic stale measurements use the real nonce probe and preserve unavailable recovery state [C7]', async t => {
  const b=box(t);b.run('runner','add',HOST);b.run('settings','gate.measuredSlots','on');useMachine(t,b);
  const value=JSON.parse(readFileSync(b.machineFile,'utf8'));value.runners[0].measuredAt='2000-01-01T00:00:00.000Z';
  writeFileSync(b.machineFile,JSON.stringify(value));b.machine(4,16);
  // Initialize only this private machine's real resource schema; an unavailable row is a recovery obligation fixture.
  runnerResourceStatus(value.runners);
  const db=new DatabaseSync(join(b.paths.machine,'resources.sqlite'));
  try {db.prepare("INSERT INTO runner_unavailable(host,since,detail) VALUES(?,?,?)").run(HOST,new Date().toISOString(),'CLEANUP_UNVERIFIED fixture');}
  finally {db.close();}
  await refreshRunnerMeasurements(loadMachineSettings(),{measure:probeRunnerTransport,record:recordRunnerMeasurement});
  const updated=loadMachineSettings().runners[0];
  assert.equal(updated.cores,4);assert.equal(updated.memoryMB,16384);
  assert.equal(effectiveRunners(loadMachineSettings())[0].slots,3);
  assert.equal(runnerResourceStatus([updated])[0].unavailable,true,'capacity measurement cannot certify cleanup');
  b.machine(8,16);
  await refreshRunnerMeasurements(loadMachineSettings(),{measure:probeRunnerTransport,record:recordRunnerMeasurement});
  assert.equal(loadMachineSettings().runners[0].cores,4,'fresh observations are reused until the periodic interval expires');
});

test('computed listing preserves the latest canonical GUI observation [C7]', t => {
  const b=box(t);b.run('runner','add',HOST);b.run('settings','gate.measuredSlots','on');useMachine(t,b);
  recordRunnerGui(HOST,true);
  assert.equal(b.list().gui,true,'computed counts cannot replace a newer positive observation');
  recordRunnerGui(HOST,false);
  assert.equal(b.list().gui,false,'computed counts cannot revive a stale positive registration');
  assert.equal(b.list().slots,9);
});

test('periodic observations wait for real leases before changing measured capacity [C7]', async t => {
  const b=box(t);b.run('runner','add',HOST);b.run('settings','gate.measuredSlots','on');useMachine(t,b);
  const settings=loadMachineSettings();settings.runners[0].measuredAt='2000-01-01T00:00:00.000Z';
  writeFileSync(b.machineFile,JSON.stringify(settings));b.machine(4,16);
  const lease=await takeResource({name:'gate',capacity:1,browserCapacityProvider:()=>1,scope:'machine',
    root:b.paths.repo,repo:b.paths.repo,agent:'measured-busy-fixture',remote:true,runnerOnly:true,
    runnerProvider:()=>settings.runners});
  try {
    await refreshRunnerMeasurements(loadMachineSettings(),{measure:probeRunnerTransport,record:recordRunnerMeasurement});
    assert.equal(loadMachineSettings().runners[0].cores,10,'an actual held lease prevents a capacity change');
    assert.equal(runnerResourceStatus(settings.runners)[0].inUse,1);
  } finally {lease.release();}
  await refreshRunnerMeasurements(loadMachineSettings(),{measure:probeRunnerTransport,record:recordRunnerMeasurement});
  assert.equal(loadMachineSettings().runners[0].cores,4,'an idle retry records the real fresh measurement');
});

test('a periodic observation preserves a newer explicit fixed registration [C7]', async t => {
  const b=box(t);b.run('runner','add',HOST);b.run('settings','gate.measuredSlots','on');useMachine(t,b);
  const settings=loadMachineSettings();settings.runners[0].measuredAt='2000-01-01T00:00:00.000Z';
  writeFileSync(b.machineFile,JSON.stringify(settings));b.machine(4,16);
  await refreshRunnerMeasurements(settings,{measure:async runner=>{
    const observed=await probeRunnerTransport(runner,{observeGui:true});
    b.run('runner','add',HOST,'--slots','2','--browser','1');
    return observed;
  },record:recordRunnerMeasurement});
  const runner=loadMachineSettings().runners[0];
  assert.equal(runner.cores,4);assert.equal(runner.fixed,true);
  assert.equal(runner.slots,2);assert.equal(runner.browser,1);
  assert.equal(b.list().slots,2,'late capacity facts cannot overwrite the newer declared policy');
});
