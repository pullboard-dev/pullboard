/** @pullboard-test-input source-tree */
/** A runner whose remote executable is missing fails setup and the original job requeues on another runner [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../test/cell-fixture.js';
import { runFixtureChild } from '../../../test/fixture-child.js';
import { installSshStandIn } from '../../../test/runner-ssh-fixture.js';

test('missing remote executable is RUNNER_SETUP and the original job requeues on another runner [C7]', t => {
  const box = cellProject(t);
  // The same private ssh stand-in the registration fixture gives this case, with no CLI process.
  const paths = Object.fromEntries(['home', 'bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of [...Object.values(paths), box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine, requests: join(box.dir, 'requests.jsonl') });
  const env = { ...box.env, HOME: paths.home, PATH: `${paths.bin}:${box.env.PATH}` };
  for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_PATH']) delete env[key];
  const gate = pathToFileURL(resolve(import.meta.dirname, '../../gate/index.js')).href;
  const runners = pathToFileURL(resolve(import.meta.dirname, '../index.js')).href;
  const config = pathToFileURL(resolve(import.meta.dirname, '../../config/index.js')).href;
  const landing = pathToFileURL(resolve(import.meta.dirname, '../../landing/index.js')).href;
  const source = `import {withGateSlot} from ${JSON.stringify(gate)};
import {resultFrom,runnerExecutionServices} from ${JSON.stringify(runners)};
import {landingExecutionServices} from ${JSON.stringify(landing)};
import {addRunner,setGateSlots,setBrowserSlots} from ${JSON.stringify(config)};
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
setGateSlots(1);
setBrowserSlots(1);
addRunner({host:'first',slots:1,browser:0,node:'/missing/node'});
addRunner({host:'second',slots:1,browser:0,node:process.execPath});
setBrowserSlots(0);
setGateSlots(0);
const seen=[];
const value=await withGateSlot(process.cwd(), async lease=>{
  seen.push(lease.runner.host);
  if(seen.length===1) {
    try { resultFrom({runner:lease.runner,spec:{id:'fixture'},phase:'connect'},
      {status:127,stderr:'/bin/sh: /missing/node: not found',stdout:Buffer.alloc(0)},{}); }
    catch(error) { if(error.code!=='RUNNER_SETUP' || !error.message.includes('/missing/node')) throw error; throw error; }
  }
  return lease.runner.host;
}, {executionServices,remote:true,runnerOnly:true,kind:'runner-setup-test'});
console.log(JSON.stringify({seen,value}));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.context);
  const record = JSON.parse(result.stdout.trim());
  assert.deepEqual(record.seen, ['first', 'second'], readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8') + result.stderr.slice(-1500));
  assert.equal(record.value, 'second');
});
