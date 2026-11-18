/** @pullboard-test-input packages/gate/index.js packages/resources/index.js */
/** Item checks retry one infrastructure-only gate failure, retain it in the receipt, and leave test reds alone [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { HOST } from '../../fixtures/runner/ssh.js';
import { installSshStandIn } from '../../fixtures/runner/ssh.js';
import { deadlineRetrySource } from '../../fixtures/retry.js';
import { lateTransportRetrySource } from '../../fixtures/retry.js';

/** Build a private runner pool with no configured host or relay connection. */
function fixture(t) {
  const box = cellProject(t, { real: true, gate: 'true' });
  const bin = join(box.dir, 'infra-retry-bin'), worker = join(box.dir, 'infra-retry-worker');
  const home = join(box.dir, 'infra-retry-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl'), starts = join(box.dir, 'starts.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, starts, dropFirst: false, nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: HOST, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: 200 }, runners: [runner],
  }));
  return { ...box, runner, requests };
}

/** Run a gate scenario in its private project process and return its structured result. */
function child(box, source) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('gate.io-requeue-retry.one-runner-deadline-requeues-the-same: one runner deadline requeues the same item ticket once and records both attempts [C7]', t => {
  const box = fixture(t);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const resources = pathToFileURL(join(import.meta.dirname, '../../../../resources/index.js')).href;
  const command = deadlineRetrySource(gate, resources, box.runner,
    `node -e 'console.log("INFRA_RETRY_OK")'`, executionServicesSource(gate));
  const result = child(box, command);
  assert.equal(result.green, true);
  assert.match(result.output, /INFRA_RETRY_OK/u);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].infrastructureAttempts.length, 2);
  assert.equal(result.receipts[0].infrastructureAttempts[0].kind, 'runner-wait');
  assert.equal(result.receipts[0].infrastructureAttempts[0].code, 'RUNNER_WAIT_DEADLINE');
  assert.equal(result.receipts[0].infrastructureAttempts[0].runner, box.runner.host);
  assert.equal(result.receipts[0].infrastructureAttempts[1].kind, 'retry');
  assert.equal(result.receipts[0].infrastructureAttempts[1].outcome, 'completed');
  assert.equal(result.pool.holders + result.pool.line, 0);
  assert.ok(readFileSync(box.requests, 'utf8').includes(box.runner.host), 'the successful second attempt used only the private stand-in');
});

test('gate.io-requeue-retry.a-late-transport-failure-receives-one: a late transport failure receives one fresh bounded runner admission window [C7]', t => {
  const box = fixture(t);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const source = lateTransportRetrySource(gate, box.runner, executionServicesSource(gate));
  const result = child(box, source);
  assert.equal(result.green, true);
  assert.equal(result.output, 'LATE_RETRY_OK');
  assert.equal(result.calls, 2);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].infrastructureAttempts.length, 2);
  assert.equal(result.receipts[0].infrastructureAttempts[0].kind, 'transport-lost');
  assert.equal(result.receipts[0].infrastructureAttempts[1].kind, 'retry');
  assert.equal(result.receipts[0].infrastructureAttempts[1].outcome, 'completed');
  assert.ok(readFileSync(box.requests, 'utf8').includes(box.runner.host), 'the retry used only the private stand-in');
});

test('gate.io-requeue-retry.a-real-command-failure-on-an: a real command failure on an admitted slot is returned on its first attempt [C7]', t => {
  const box = fixture(t);
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  writeFileSync(settings, JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { runnersFirst: false }, runners: [] }));
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const command = `import { withGateSlot, runProfiledShellAsync } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
let calls=0;const receipts=[];
const result=await withGateSlot(process.cwd(),lease=>{calls++;return runProfiledShellAsync(process.cwd(),'false',{gateLease:lease});},
  {executionServices,remote:false,itemCheck:true,agent:'infra-red-test',kind:'submit',item:'fixture',onReceipt:receipt=>receipts.push(receipt)});
console.log(JSON.stringify({green:result.isGreen,calls,receipts}));`;
  const result = child(box, command);
  assert.equal(result.green, false);
  assert.equal(result.calls, 1);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].infrastructureAttempts, undefined);
});
