/** The runner job runs the real hand-off stages from its ticket; a red ends it with the local worker's failure account [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_STAGES, failureAccount, runHandoffStages } from '../apps/runner/src/shell/runner-handoff-stages.js';
import { handoffStageServices } from '../apps/cli/src/shell/runner-handoff-services.js';
import { runFixtureGit } from './fixture-child.js';

const IDENTITY = ['-c', 'user.name=Stage Test', '-c', 'user.email=stage@example.test', '-c', 'commit.gpgsign=false'];
const SERVICES = handoffStageServices();
const JOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A fixture runner: a real checkout of one commit and its own log file, outside this machine's logs. */
function fixtureRunner(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-handoff-stages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'runner-checkout');
  runFixtureGit(['init', '-q', '-b', 'main', root]);
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
