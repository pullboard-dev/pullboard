/** @pullboard-test-input packages/config/index.js packages/gate/index.js packages/landing/index.js packages/runners/index.js */
/** Registration preserves remote configuration and setup failures move to another runner [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { registrationGuiFixture } from '../../tests/fixtures/runner/gui.js';
import { cli } from '../../tests/fixtures/runner/tooling.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

test('runner add discovers Node and keeps node and root on re-registration [C7]', t => {
  const box = registrationGuiFixture(t);
  const discovered = box.register();
  assert.match(discovered.node, /^\//u);
  const first = cli(box.repo, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--node', process.execPath, '--root', join(box.directory, 'remote-root'), '--json');
  assert.equal(first.status, 0, first.context);
  const again = box.register();
  assert.equal(again.node, process.execPath);
  assert.equal(again.root, join(box.directory, 'remote-root'));
});

test('missing remote executable is RUNNER_SETUP and the original job requeues on another runner [C7]', t => {
  const box = registrationGuiFixture(t);
  const gate = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  const runners = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const config = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/config/index.js')).href;
  const landing = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/landing/index.js')).href;
  const source = `import {withGateSlot} from ${JSON.stringify(gate)};
import {resultFrom,runnerExecutionServices} from ${JSON.stringify(runners)};
import {landingExecutionServices} from ${JSON.stringify(landing)};
import {addRunner,setGateSlots,setBrowserSlots} from ${JSON.stringify(config)};
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
addRunner({host:'first',slots:1,browser:0,node:'/missing/node'});
setBrowserSlots(0);
setGateSlots(0);
const seen=[];
const value=await withGateSlot(process.cwd(), async lease=>{
  seen.push(lease.runner.host);
  if(seen.length===1) {
    addRunner({host:'second',slots:1,browser:0,node:process.execPath});
    try { resultFrom({runner:lease.runner,spec:{id:'fixture'},phase:'connect'},
      {status:127,stderr:'/bin/sh: /missing/node: not found',stdout:Buffer.alloc(0)},{}); }
    catch(error) { if(error.code!=='RUNNER_SETUP' || !error.message.includes('/missing/node')) throw error; throw error; }
  }
  return lease.runner.host;
}, {executionServices,remote:true,runnerOnly:true,kind:'runner-setup-test'});
console.log(JSON.stringify({seen,value}));`;
  const env = { ...box.env, PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0' };
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.context);
  const record = JSON.parse(result.stdout.trim());
  assert.deepEqual(record.seen, ['first', 'second']);
  assert.equal(record.value, 'second');
});
