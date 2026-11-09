/** @pullboard-test-input source-tree */
/** Registration preserves remote configuration and setup failures move to another runner [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registrationGuiFixture } from '../../../test/runner-registration-gui-fixture.js';
import { cli } from '../../../test/runner-tooling-fixture.js';
import { HOST } from '../../../test/runner-ssh-fixture.js';
import { runFixtureChild } from '../../../test/fixture-child.js';

import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
function dump(home) {
  const out = [readdirSync(home).join(',')];
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) out.push(name + ' ' + JSON.stringify(db.prepare('SELECT * FROM ' + name + ' LIMIT 8').all()).slice(0, 700));
  return out.join('\n');
}
test('missing remote executable is RUNNER_SETUP and the original job requeues on another runner [C7]', t => {
  const box = registrationGuiFixture(t);
  const gate = pathToFileURL(resolve(import.meta.dirname, '../../gate/index.js')).href;
  const runners = pathToFileURL(resolve(import.meta.dirname, '../index.js')).href;
  const config = pathToFileURL(resolve(import.meta.dirname, '../../config/index.js')).href;
  const landing = pathToFileURL(resolve(import.meta.dirname, '../../landing/index.js')).href;
  const source = `import {withGateSlot} from ${JSON.stringify(gate)};
import {resultFrom,runnerExecutionServices} from ${JSON.stringify(runners)};
import {landingExecutionServices} from ${JSON.stringify(landing)};
import {addRunner,setGateSlots,setBrowserSlots} from ${JSON.stringify(config)};
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
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
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.context);
  const record = JSON.parse(result.stdout.trim());
  assert.deepEqual(record.seen, ['first', 'second'], dump(box.machine) + result.stderr.slice(-1500));
  assert.equal(record.value, 'second');
});
