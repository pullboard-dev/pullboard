/** A landing gate's rerun fans out over runner slots like a submit proof, and its records stay one run's [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLECTION_REPORT_PREFIX } from '../../../src/logic/collection/report.js';
import { formatCollectionReport } from '../../../src/logic/collection/report.js';
import { parseCollectionReports } from '../../../src/logic/collection/report.js';
import { combineCollectionReports } from '../../../src/io/shards/landing.js';
import { landingShardable } from '../../../src/io/shards/landing.js';
import { landingShardExecution } from '../../../src/io/shards/landing.js';
import { planWrapper } from '../../../src/io/shards/landing.js';
import { PROOF_MAX_SHARDS } from '../../../src/io/shards/proof.js';

const RUNNER = 'node apps/cli/src/io/run/tests.js';
const ID = '11111111-2222-4333-8444-555555555555';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const filesCommand = files => `${RUNNER} ${files.map(file => quote('./' + file)).join(' ')}`;
const wrapper = command => `(export PULLBOARD_LANDING_COLLECT_ALL=1 PULLBOARD_COLLECTION_ID=${ID}\n${command}\n)`;

/** The files a command names, read back from its quoted words. */
function namedFiles(command) {
  return [...command.matchAll(/'\.\/([^']+)'/gu)].map(match => match[1]);
}

/** A runner stand-in: each run prints its files' TAP lines and a suite collection report for them, under the shared id. */
function runner(calls, { red = null } = {}) {
  return async (root, command, options) => {
    const files = namedFiles(command);
    calls.push({ command, files, timingRunId: options.metadata.timingRunId });
    const failed = files.includes(red);
    return { isGreen: !failed, exitCode: failed ? 1 : 0, executionRunner: `runner-${calls.length}`, remoteWallMs: 10,
      output: files.map(file => `ok - ${file}`).join('\n') + '\n' + formatCollectionReport({ id: ID, scope: 'suite', shard: null, plannedFiles: files,
        completedFiles: files, complete: true, cleanupVerified: true }) };
  };
}

/** The profiled plan the landing gate hands to its execute step. */
function plan(files, runOnRunnerAsync) {
  const command = filesCommand(files);
  return { command, remoteCommand: wrapper(command), gateLease: { runner: { host: 'runner-a' }, executionServices: { runners: { runOnRunnerAsync } } },
    remoteOptions: { metadata: { timingRunId: 'run-1' }, source: {} } };
}

test('clause 1: a landing rerun of many files runs as at most three runner shards under the collection wrapper, merged into one run [C7]', async () => {
  const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js', 'f.test.js'];
  const calls = [];
  const run = runner(calls);
  const execution = plan(files, run);
  const taken = [];
  const takeSlot = (lane, { closed }) => { taken.push(closed); return lane(batch => run('/repo', planWrapper(execution)(filesCommand(batch)), execution.remoteOptions)); };
  const merged = await landingShardExecution('/repo', { files, filesCommand }, { browser: false }, { takeSlot, freeSlots: () => 5 })(execution);
  assert.ok(calls.length >= 2 && calls.length <= PROOF_MAX_SHARDS, `${calls.length} shard runs`);
  assert.deepEqual(calls.flatMap(call => call.files).sort(), files, 'every file runs exactly once');
  for (const call of calls) {
    assert.match(call.command, /^\(export PULLBOARD_LANDING_COLLECT_ALL=1 /u, 'each shard collects every failure, as the whole gate does');
    assert.equal(call.timingRunId, 'run-1', 'each shard reports under the gate\'s one timing run id');
  }
  assert.equal(merged.isGreen, true);
  assert.equal(merged.shards.length, calls.length);
  const report = parseCollectionReports(merged.output, { id: ID, scope: 'suite', requireComplete: true });
  assert.ok(report, 'the merged output carries exactly one complete suite collection report');
  assert.deepEqual(report.plannedFiles, files);
  assert.equal(merged.output.split('\n').filter(line => line.startsWith(COLLECTION_REPORT_PREFIX)).length, 1);
});

test('clause 2: a red shard makes the merged landing run red, and its collection stays complete so the red can be accounted [C7]', async () => {
  const files = ['a.test.js', 'b.test.js', 'c.test.js'];
  const calls = [];
  const run = runner(calls, { red: 'b.test.js' });
  const execution = plan(files, run);
  const takeSlot = lane => lane(batch => run('/repo', planWrapper(execution)(filesCommand(batch)), execution.remoteOptions));
  const merged = await landingShardExecution('/repo', { files, filesCommand }, { browser: false }, { takeSlot, freeSlots: () => 3 })(execution).catch(error => ({ error }));
  // A red batch may end the queue early as a refusal or come back red; either way nothing reads as green.
  if (merged.error) return assert.notEqual(merged.error.code, undefined);
  assert.equal(merged.isGreen, false);
  assert.notEqual(merged.exitCode, 0);
});

test('clause 3: only a gate whose command is exactly its files under the focused runner shards; one file, or another command, runs whole [C7]', () => {
  const files = ['a.test.js', 'b.test.js'];
  assert.equal(landingShardable(filesCommand(files), { files, filesCommand }), true);
  assert.equal(landingShardable(filesCommand(['a.test.js']), { files: ['a.test.js'], filesCommand }), false, 'one file has nothing to fan out');
  assert.equal(landingShardable(`(\nnpm test\n) && ${filesCommand(files)}`, { files, filesCommand }), false, 'an opaque configured gate keeps its single run');
  assert.equal(landingShardable(filesCommand(files), null), false);
  assert.equal(planWrapper({ command: 'x', remoteCommand: 'x' })('y'), 'y');
  assert.equal(planWrapper({ command: 'x', remoteCommand: '(export A=1\nx\n)' })('y'), '(export A=1\ny\n)');
});

test('clause 4: one suite report per shard joins into the one report the gate reads; a single report is left as it was [C7]', () => {
  const one = formatCollectionReport({ id: ID, scope: 'suite', shard: null, plannedFiles: ['a.test.js'], completedFiles: ['a.test.js'], complete: true, cleanupVerified: true });
  const two = formatCollectionReport({ id: ID, scope: 'suite', shard: null, plannedFiles: ['b.test.js'], completedFiles: [], complete: false, cleanupVerified: true });
  assert.equal(combineCollectionReports(`ok\n${one}`), `ok\n${one}`);
  const joined = combineCollectionReports(`ok\n${one}ok\n${two}`);
  const report = parseCollectionReports(joined, { id: ID, scope: 'suite', requireComplete: false });
  assert.deepEqual(report.plannedFiles, ['a.test.js', 'b.test.js']);
  assert.deepEqual(report.completedFiles, ['a.test.js']);
  assert.equal(report.complete, false, 'an incomplete shard leaves the whole run incomplete');
});
