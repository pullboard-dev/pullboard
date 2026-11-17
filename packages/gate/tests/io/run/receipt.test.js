/** The shards of one run merge into one result and receipt, and a failing file in any shard fails the run naming it [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { proveBatches } from '../../../src/io/shards/proof.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'];
const COMMAND = 'node apps/cli/src/io/run/tests.js ';
const TREE = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const filesCommand = files => COMMAND + files.map(file => './' + file).join(' ');

/** Own a private machine home, so the shard pass store is this test's alone. */
function machine(t) {
  const { root: directory } = privateFixtureFiles('pullboard-run-shards-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

/** A runner-lease execution whose batches go through `runBatch`, as the gate's first lane does. */
function execution(runBatch) {
  return { gateLease: { runner: { host: 'fixture-gate' }, executionServices: { runners: {
    runOnRunnerAsync: async (root, command) => runBatch(command.slice(COMMAND.length).split(' ').map(file => file.replace(/^\.\//u, ''))) } } },
  remoteCommand: filesCommand(FILES), remoteOptions: { source: { commit: COMMIT, tree: TREE }, metadata: { timingRunId: randomUUID() } } };
}

/** A second runner slot that runs the batches it pulls through the same fixture run. */
const slotFor = runBatch => async lane => lane(files => runBatch(files));

/** One batch's run: red when it holds a file in `bad`, naming that file in its output. */
const batchRun = bad => files => {
  const red = files.filter(file => bad.includes(file));
  return { isGreen: red.length === 0, exitCode: red.length ? 1 : 0, executionRunner: 'fixture-a', remoteWallMs: 5,
    executionSource: { commit: COMMIT, tree: TREE }, output: red.length ? `not ok ${red.join(' ')}` : `ok ${files.join(' ')}` };
};

test('gate.io-run-receipt.shards-of-one-run-merge-into: clause 1: shards of one run merge into one result and receipt identical in content to a single-slot run [test] [C7]', async t => {
  machine(t);
  const takeSlot = slotFor(batchRun([]));
  const run = size => proveBatches('/controller', execution(batchRun([])), { files: FILES, filesCommand, takeSlot, freeSlots: 2, batchFiles: size, passes: null });
  const single = await run(FILES.length);
  const split = await run(2);
  assert.ok(split.shards.length > 1, 'the files ran as several shards');
  assert.equal(single.isGreen, true);
  assert.deepEqual([split.isGreen, split.exitCode, split.failingFiles], [single.isGreen, single.exitCode, single.failingFiles ?? []]);
  assert.deepEqual(split.shards.flatMap(shard => shard.files).sort(), FILES, 'the one receipt names every file once');
});

test('gate.io-run-receipt.a-failing-file-in-any-shard: clause 2: a failing file in any shard fails the run with that file named [test] [C7]', async t => {
  machine(t);
  const bad = batchRun(['test/d.test.js']);
  const takeSlot = slotFor(bad);
  const merged = await proveBatches('/controller', execution(bad), { files: FILES, filesCommand, takeSlot, freeSlots: 2, batchFiles: 2, passes: null });
  assert.equal(merged.isGreen, false);
  assert.equal(merged.exitCode, 1);
  assert.deepEqual(merged.failingFiles, ['test/d.test.js']);
  assert.match(merged.output, /not ok test\/d\.test\.js/u);
});
