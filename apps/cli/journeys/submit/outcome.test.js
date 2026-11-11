/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private SSH worker/CLI controls exercise remote failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { cli } from '../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../tests/fixtures/submit/outcome.js';
import { put } from '../../tests/fixtures/submit/outcome.js';
import { source } from '../../tests/fixtures/submit/outcome.js';
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/index.js';
import { SUITE_TIMING_PREFIX } from '../../../../packages/gate/index.js';
import { timingAccountingStages } from '../../../../packages/gate/index.js';
import { accountedFailures } from '../../../../packages/landing/index.js';
import { testOutputSummary } from '../../../../packages/gate/index.js';

/** A portable copy of the production collector observes real Node events inside the worker's source tree. */
function beforeMain({ duplicate = false, phases = false, timing = true, corrupt = null } = {}) {
  return box => {
    const files = ['test/inherited.test.js', ...(duplicate ? ['test/second.test.js'] : []), ...(phases ? ['test/shared-pass.test.js'] : [])];
    const timingModule = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    const beginTiming = timing ? 'beginSuiteTiming(process.cwd(), process.argv.slice(2));' : '';
    if (duplicate) put(box.root, 'test/second.test.js', source());
    if (phases) {
      put(box.root, 'test/check-only.test.js', "import { test } from 'node:test';\ntest('criterion only pass [G1]', () => {});\n");
      put(box.root, 'test/shared-pass.test.js', "import { test } from 'node:test';\ntest('shared phase pass [G1]', () => {});\n");
      put(box.root, 'test/check-runner.js', `import { spawnSync } from 'node:child_process';
import { beginSuiteTiming } from ${JSON.stringify(timingModule)};
// The actual private controller observes its own clean source and wall duration.
${beginTiming}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=./test/outcome-reporter.js',
  'test/check-only.test.js', 'test/shared-pass.test.js'], { encoding: 'utf8', env: process.env });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? ''); process.exitCode = run.status ?? 1;
`);
    }
    put(box.root, 'test/native-outcomes.js', readFileSync(new URL("../../../../packages/gate/src/io/test/outcomes.js", import.meta.url), 'utf8'));
    put(box.root, 'test/outcome-reporter.js', `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from './native-outcomes.js';
export default async function* report(events) {
  const collector = testOutcomeCollector(process.cwd());
  let count = null;
  async function* observe() {
    for await (const event of events) {
      collector.observe(event);
      if (event.type === 'test:summary') count = event.data.counts.tests;
      yield event;
    }
  }
  for await (const chunk of tap(observe())) yield chunk;
  const outcomes = formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));
  yield ${corrupt === 'malformed' ? "outcomes.replace('version', 'invalidVersion')" : 'outcomes'};
  ${corrupt === 'foreign' ? "yield formatTestOutcomes('00000000-0000-4000-8000-000000000000', collector.finish(count !== null, count));" : ''}
}
`);
    put(box.root, 'test/runner.js', `import { spawnSync } from 'node:child_process';
import { beginSuiteTiming } from ${JSON.stringify(timingModule)};
// Preserve genuine producer timing; no fabricated frame or completed-file claim.
${beginTiming}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=./test/outcome-reporter.js', ...${JSON.stringify(files)}],
  { encoding: 'utf8', env: process.env });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
process.exitCode = run.status ?? 1;
`);
  };
}

/** The existing stand-in launches the real worker locally; zero local slots prove the remote path was used. */
function remote(box) {
  const bin = join(box.directory, 'remote-bin'), worker = join(box.directory, 'worker'), home = join(box.directory, 'worker-home');
  const machineHome = join(home, '.pullboard'), requests = join(box.directory, 'requests.jsonl');
  for (const path of [bin, worker, home, machineHome]) mkdirSync(path, { recursive: true });
  box.env.PATH = bin + ':' + box.env.PATH;
  installSshStandIn({ bin, worker, home, machineHome, requests });
  let result = cli(box, box.root, 'runner', 'add', HOST, '--slots', '1', '--browser', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    result = cli(box, box.root, 'settings', key, value);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  return requests;
}

/** Read actual profile bytes through public response paths; do not manufacture failure identity. */
function readProfile(path) { return JSON.parse(readFileSync(path, 'utf8')); }

test('a real remote submit retains the failing source file and exact main failure receipt [V4,B3,H16]', t => {
  const box = fixture(t, { beforeMain: beforeMain({ phases: true }), check: 'node test/check-runner.js' });
  const requests = remote(box);
  const result = cli(box, box.builder, 'submit', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout), gate = report.gate;
  assert.equal(gate.green, false, 'the inherited assertion remains red');
  assert.equal(gate.knownMainFailures.main, box.main);
  assert.deepEqual(gate.knownMainFailures.failures.map(({ file, name }) => ({ file, name })),
    [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
  const phase = readProfile(gate.proofProfilePath), combined = readProfile(gate.profilePath);
  assert.equal(phase.executionRunner, HOST);
  assert.equal(phase.executionSource.commit, box.head);
  const check = readProfile(gate.check.profilePath);
  assert.equal(check.executionRunner, HOST);
  assert.equal(check.executionSource.commit, box.head);
  assert.deepEqual(combined.testOutcomes.map(({ file, name, passed }) => ({ file, name, passed })), [
    { file: 'test/check-only.test.js', name: 'criterion only pass [G1]', passed: true },
    { file: 'test/shared-pass.test.js', name: 'shared phase pass [G1]', passed: true },
    { file: 'test/inherited.test.js', name: 'shared failure [G1]', passed: false },
  ], 'both phases survive and repeated identical source cases stay unique');
  const summary = testOutputSummary(gate.log, { root: box.builder, profile: combined });
  assert.equal(summary.failures[0].file, 'test/inherited.test.js');
  assert.equal(summary.failures[0].name, 'shared failure [G1]');
  assert.deepEqual(submittedProof(box).submissionProof.knownMainFailures, gate.knownMainFailures);
  const raw = readFileSync(gate.proofLog, 'utf8');
  const timingLine = raw.split('\n').find(line => line.startsWith(SUITE_TIMING_PREFIX));
  assert.ok(timingLine, 'the real private controller published its own suite timing');
  const timing = JSON.parse(timingLine.slice(SUITE_TIMING_PREFIX.length));
  const unbound = raw.split('\n').filter(line => !line.startsWith(SUITE_TIMING_PREFIX)).join('\n');
  const stages = timingAccountingStages([{ status: 1, pipeline: [
    { status: 1, output: raw }, { status: 1, output: unbound },
  ] }], timing.id, { head: timing.head, tree: timing.tree });
  assert.equal(stages[0].pipeline[0].testOutcomeRunId, timing.id);
  assert.equal(stages[0].pipeline[1].testOutcomeRunId, null, 'a sibling cannot lend its source-bound producer');
  assert.equal(accountedFailures({ isGreen: false, stages }, box.builder), null);
  const launched = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(launched.some(row => row.workerStarted), 'the real private worker executed');
});

test('ambiguous remote duplicate titles keep missing file identity and cannot submit [V4,B3,H16]', t => {
  const box = fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
  remote(box);
  const result = cli(box, box.builder, 'submit', String(box.item));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.error.code, 'GATE_RED');
  assert.ok(report.failures.length >= 2);
  assert.ok(report.failures.every(row => row.file === null), 'neither title arbitrarily selects the first file');
  assert.ok(report.failures.every(row => row.name === 'shared failure [G1]'));
  assert.equal(submittedProof(box), null);
});

test('a remote same-title item regression stays red when its assertion differs from main [V4,B3,H16]', t => {
  const box = fixture(t, { beforeMain: beforeMain(), candidate: source('shared failure [G1]', 3) });
  remote(box);
  const result = cli(box, box.builder, 'submit', String(box.item));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.error.code, 'GATE_RED');
  assert.equal(report.failures[0].file, 'test/inherited.test.js');
  assert.equal(submittedProof(box), null, 'complete file identity does not relax the exact assertion signature guard');
});

for (const control of [
  { name: 'unbound', timing: false },
  { name: 'foreign', corrupt: 'foreign' },
  { name: 'malformed', corrupt: 'malformed' },
]) {
  test(`a real remote submit refuses ${control.name} native outcome records [V4,B3,H16]`, t => {
    const box = fixture(t, { beforeMain: beforeMain(control) });
    remote(box);
    const result = cli(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
    assert.equal(submittedProof(box), null, 'native diagnostics cannot authorize an unbound failure account');
  });
}
