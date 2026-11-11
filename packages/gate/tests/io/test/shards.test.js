/** @pullboard-test-input source-tree */
/** Gate owns the test-run shard orchestration; runner and landing steps arrive as injected services [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { fixtureMachineSettings } from '../../../../../apps/cli/tests/fixtures/testkit.js';

const HOSTS = [HOST, `${HOST}-second`];
const FILES = ['test/a.test.js', 'test/b.test.js'];

/**
 * A private pool of one-slot stand-in runners and no local gate slot, so every shard must take a runner slot.
 *
 * @param {import('node:test').TestContext} t
 * @returns {object} The project box.
 */
function fixture(t, hosts = HOSTS) {
  const box = cellProject(t, { gate: 'true' });
  const bin = join(box.dir, 'shards-bin'), worker = join(box.dir, 'shards-worker');
  const home = join(box.dir, 'shards-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests: join(box.dir, 'requests.jsonl'), starts: join(box.dir, 'starts.jsonl'), dropFirst: false, nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, {
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: 200 },
    runners: hosts.map(host => ({ host, slots: 1, browser: 0, node: process.execPath })),
  });
  return box;
}

/**
 * The child source: runTestShards over two files, with the canonical services wrapped to count their calls. The injected
 * runner stand-in holds each shard until both have arrived, so two shards that each hold a one-slot runner must be on two hosts.
 *
 * @param {string} gateUrl
 * @param {string} root
 * @param {boolean} [quarantine] Run runner-only, with every runner answer a setup refusal that quarantines its host.
 * @returns {string}
 */
function scenario(gateUrl, root, quarantine = false) {
  return `import { runTestShards, RunnerDropped } from ${JSON.stringify(gateUrl)};
import { Refused } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../kernel/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../kernel/src/logic/census.js')).href)};
${executionServicesSource(gateUrl)}
const calls = [], seen = { landingHost: 0, pins: 0, local: 0 }, log = [];
let arrived = 0, open;
const both = new Promise(resolve => { open = resolve; });
const services = {
  runners: { ...executionServices.runners, runOnRunnerAsync: async (_root, command, options) => {
    calls.push({ host: options.runner.host, command });
    ${quarantine ? "throw new Refused('RUNNER_SETUP', 'the runner could not set up');" : ''}
    if (++arrived === ${FILES.length}) open();
    await both;
    return { isGreen: true, output: '' };
  } },
  landing: { ...executionServices.landing, constrainedLandingHost: (root) => { seen.landingHost++; return executionServices.landing.constrainedLandingHost(root); } },
};
const result = await runTestShards({ parseProcessCensus, root: ${JSON.stringify(root)}, runner: ${JSON.stringify(join(root, 'apps/cli/src/io/run/tests.js'))},
  files: ${JSON.stringify(FILES)}, count: 2, needsBrowser: async () => false, needsGui: async () => false,
  runnerAdmission: { runnerOnly: ${quarantine} }, executionServices: services, runnerKinds: { RunnerDropped }, write: text => log.push(text),
  pinSource: () => { seen.pins++; return { commit: 'a'.repeat(40), fingerprint: 'fixture' }; },
  runLocalShard: async () => { seen.local++; throw new Error('a runner slot must take every shard here'); } });
console.log(JSON.stringify({ green: result.isGreen, calls, seen, shards: result.shards, log: log.join('') }));`;
}

test('clause 1: a two-file run splits across two runner slots, one file each [C7,V4]', { timeout: 150_000 }, t => {
  const box = fixture(t);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', scenario(gate, box.repo)], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, true, measured.log);
  assert.equal(measured.shards.length, 2);
  assert.deepEqual(measured.calls.map(call => call.host).sort(), [...HOSTS].sort(), 'each runner slot ran one shard');
  for (const file of FILES) assert.equal(measured.calls.filter(call => call.command.includes(file)).length, 1, `${file} ran in exactly one shard`);
  for (const call of measured.calls) assert.equal(FILES.filter(file => call.command.includes(file)).length, 1, 'a shard holds one of the two files');
  assert.match(measured.log, /# landing shards: 2 balanced by file count/u);
});

test('clause 2: the injected runner and landing services are the ones called, and missing services are refused [C7,V4]', { timeout: 150_000 }, t => {
  const box = fixture(t);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', scenario(gate, box.repo)], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.calls.length, 2, 'the injected runOnRunnerAsync ran both shards');
  assert.equal(measured.seen.landingHost, 2, 'the injected landing host policy was asked once per shard slot');
  assert.equal(measured.seen.pins, 1, 'the injected source pin ran once for the whole run');
  assert.equal(measured.seen.local, 0, 'the injected local shard runner is used only for a local slot');
  const refusal = runFixtureChild(process.execPath, ['--input-type=module', '-e', `import { runTestShards } from ${JSON.stringify(gate)};
try { await runTestShards({ root: ${JSON.stringify(box.repo)}, runner: 'x', files: ['a.test.js'], count: 1, parseProcessCensus() {}, runnerAdmission: {}, runLocalShard() {}, pinSource() {} }); }
catch (error) { console.log(JSON.stringify({ type: error.constructor.name, message: error.message })); }`], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(refusal.status, 0, refusal.failure || refusal.stderr || refusal.stdout);
  const refused = JSON.parse(refusal.stdout);
  assert.equal(refused.type, 'TypeError');
  assert.match(refused.message, /explicit runner and landing services/u);
});

test('clause 1: a runner-only shard leased a runner quarantined in this run ends as infrastructure, never a throw [C7,V4]', { timeout: 150_000 }, t => {
  const box = fixture(t, [HOST]);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../index.js')).href;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', scenario(gate, box.repo, true)], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, false);
  assert.equal(measured.seen.local, 0, 'a runner-only run never falls back to a local slot');
  assert.ok(measured.shards.some(shard => shard.status === 'infrastructure'), JSON.stringify(measured.shards));
  assert.match(measured.log, /runner-only landing refuses quarantined runner/u);
});
