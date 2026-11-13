/** @pullboard-test-input apps/cli/src/io/runner/handoff/child.js */
/** @pullboard-world-pin: the wiring case reads the runner worker's own source files to prove the job path calls the stages. */
/** The runner job runs the real hand-off stages from its ticket; a red ends it with the local worker's failure account [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HANDOFF_STAGES,
  failureAccount,
  runHandoffStages,
} from '../../../runner/index.js';
import { runHandoffJob } from '../../../runner/src/io/worker/handoff.js';
import { SPEC_RULES } from '../../../runner/src/io/spec.js';
import { handoffStageServices } from '../../src/io/runner/handoff/services.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';

const IDENTITY = ['-c', 'user.name=Stage Test', '-c', 'user.email=stage@example.test', '-c', 'commit.gpgsign=false'];
const SERVICES = handoffStageServices();
const JOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A fixture runner: a real checkout of one commit and its own log file, outside this machine's logs. */
function fixtureRunner(t) {
  const dir = privateFixtureFiles('pullboard-handoff-stages-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = temporaryRepository(t, 'pullboard-handoff-checkout-');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'one'], { cwd: root });
  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const tree = runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: root }).trim();
  return { dir, root, commit, tree, logFile: join(dir, 'runner.log') };
}

test('clause 1: the runner runs authorization, doctrine, cells, composition, criterion and proof in order, each stage line and duration in its own log and in no other [C7]', async t => {
  const box = fixtureRunner(t);
  const seen = [];
  const stages = Object.fromEntries(HANDOFF_STAGES.map(name => [name, async (_root, _input, log) => { seen.push(name); log(`  ${name} detail`); }]));
  let clock = 0;
  const result = await runHandoffStages(box.root, { job: JOB, commit: box.commit, tree: box.tree }, { logFile: box.logFile, services: SERVICES, stages, now: () => (clock += 5) });
  assert.deepEqual(HANDOFF_STAGES, ['authorization', 'doctrine', 'cells', 'composition', 'criterion', 'proof']);
  assert.deepEqual(seen, [...HANDOFF_STAGES]);
  assert.equal(result.green, true);
  assert.deepEqual(result.stages.map(stage => [stage.name, stage.ms, stage.state]), HANDOFF_STAGES.map(name => [name, 5, 'ok']));
  const lines = readFileSync(box.logFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.filter(line => line.endsWith(' start')).map(line => line.split(' ')[4]), seen);
  assert.equal(lines.filter(line => / ok 5ms$/u.test(line)).length, HANDOFF_STAGES.length, 'every stage line carries its duration');
  assert.equal(JSON.stringify(result).includes('detail'), false, 'the returned result carries no stage line, so no log of the submitting machine does');
});

test('clause 1: the real authorization stage refuses a checkout that is not the ticket commit with the local refusal code, and no later stage runs [C7]', async t => {
  const box = fixtureRunner(t);
  const seen = [];
  const stages = Object.fromEntries(HANDOFF_STAGES.slice(1).map(name => [name, async () => { seen.push(name); }]));
  const wrong = await runHandoffStages(box.root, { job: JOB, commit: 'f'.repeat(40) }, { logFile: box.logFile, services: SERVICES, stages });
  assert.equal(wrong.green, false);
  assert.equal(wrong.failed.stage, 'authorization');
  assert.equal(wrong.failed.code, 'RUNNER_SOURCE');
  assert.deepEqual(seen, []);
  const tree = await runHandoffStages(box.root, { job: JOB, commit: box.commit, tree: 'e'.repeat(40) }, { logFile: box.logFile, services: SERVICES, stages });
  assert.equal(tree.failed.code, 'RUNNER_SOURCE');
});

test('clause 2: a red criterion or proof ends the job with the failing file, case and signature the local worker records [C7]', async t => {
  const box = fixtureRunner(t);
  const tap = ['TAP version 13', 'not ok 1 - the sum is wrong', '  ---', "  location: 'failing.test.js:3:1'", '  error: boom', '  ...', '1..1', ''].join('\n');
  writeFileSync(join(box.root, 'tap.txt'), tap);
  const noop = async () => {};
  const stages = { authorization: noop, doctrine: noop, cells: noop, composition: noop };
  const red = await runHandoffStages(box.root, { job: JOB, commit: box.commit, check: 'cat tap.txt; exit 1' }, { logFile: box.logFile, services: SERVICES, stages });
  assert.equal(red.green, false);
  assert.deepEqual(red.stages.map(stage => [stage.name, stage.state]), [...['authorization', 'doctrine', 'cells', 'composition'].map(name => [name, 'ok']), ['criterion', 'red']]);
  assert.equal(red.failed.stage, 'criterion');
  assert.equal(red.failed.code, 'GATE_RED');
  assert.deepEqual(red.failed.failures.map(row => [row.file, row.case]), [['failing.test.js', 'the sum is wrong']]);
  assert.deepEqual(red.failed.failures, await failureAccount(tap, box.root, SERVICES), 'the account is the one the shared reader makes');
  assert.match(readFileSync(box.logFile, 'utf8'), /stage criterion red \d+ms criterion exited 1/u);
  const proof = await runHandoffStages(box.root, { job: JOB, commit: box.commit, proofCommand: 'cat tap.txt; exit 1' }, { logFile: box.logFile, services: SERVICES, stages });
  assert.equal(proof.failed.stage, 'proof');
  assert.equal(proof.failed.code, 'TEST_FAILURE');
  const green = await runHandoffStages(box.root, { job: JOB, commit: box.commit, check: 'true', proofCommand: 'true' }, { logFile: box.logFile, services: SERVICES, stages });
  assert.equal(green.green, true);
});

test('clause 1: the worker job path runs a spec ticket through runHandoffJob, with the real authorization and command stages and its lines only in the runner root [C7]', async t => {
  const box = fixtureRunner(t);
  const entry = join(import.meta.dirname, '../../src/io/runner/handoff/child.js');
  const spec = { id: JOB, commit: box.commit, tree: box.tree, main: box.commit, handoff: { check: 'echo criterion-line', proofCommand: 'echo proof-line' } };
  const job = await runHandoffJob(spec, box.root, box.dir, { entry });
  assert.equal(job.code, 0);
  assert.equal(job.handoff.green, true);
  assert.deepEqual(job.handoff.stages.map(stage => stage.name), HANDOFF_STAGES);
  assert.equal(JSON.stringify(job).includes('criterion-line'), false, 'no stage line travels in the job result');
  const log = readFileSync(join(box.dir, 'handoff.log'), 'utf8');
  assert.match(log, /criterion-line/u);
  assert.match(log, /proof-line/u);
  const red = await runHandoffJob({ ...spec, handoff: { check: 'exit 3' } }, box.root, box.dir, { entry });
  assert.equal(red.code, 1);
  assert.equal(red.handoff.failed.stage, 'criterion');
  const wrong = await runHandoffJob({ ...spec, commit: 'f'.repeat(40) }, box.root, box.dir, { entry });
  assert.equal(wrong.handoff.failed.code, 'RUNNER_SOURCE');
});

test('clause 1: the runner worker calls runHandoffJob for a spec that carries a ticket, validates the ticket and reports it in the receipt [C7]', () => {
  const readWorker = name => readFileSync(join(import.meta.dirname, '../../../../apps/runner/src/io/worker', name), 'utf8');
  assert.match(readWorker('entry.js'), /spec\.handoff \? await runHandoffJob\(spec, root, runnerRoot\)/u);
  assert.match(readWorker('handoff.js'), /runStageEntry\(entry \?\? mainEntry/u);
  assert.match(readFileSync(join(import.meta.dirname, '../../src/io/runner/handoff/child.js'), 'utf8'), /runHandoffStages\(root, input/u);
  assert.match(readWorker('spec.js'), /throw new Error\('invalid hand-off ticket'\)/u);
  assert.ok(SPEC_RULES.has('invalid hand-off ticket'));
  assert.match(readWorker('receipt.js'), /fields\.handoff \? \{ handoff: fields\.handoff \}/u);
});
