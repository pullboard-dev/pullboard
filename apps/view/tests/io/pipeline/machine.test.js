/** This machine's CPU by part of the process, and the leases it holds, as the Pipeline page reads them [N26,#6869]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { aggregateParts } from '../../../src/io/pipeline/machine.js';
import { cpuSampler } from '../../../src/io/pipeline/machine.js';
import { machineRead } from '../../../src/io/pipeline/machine.js';
import { partOf } from '../../../src/io/pipeline/machine.js';
import { queuedTickets } from '../../../src/io/pipeline/machine.js';
import { readLeases } from '../../../src/io/pipeline/machine.js';

test('view.x-io-pipeline-machine.clause-2-a-process-belongs-to-the: clause 2: a process belongs to the part of the pipeline its command line names [N26,#6869]', () => {
  assert.equal(partOf('/usr/libexec/fseventsd'), 'macOS file indexing');
  assert.equal(partOf('node /x/submit-handoff-worker.js --job 4'), 'gate hand-off workers');
  assert.equal(partOf('node apps/runner/runner-controller.js'), 'runner controllers');
  assert.equal(partOf('node apps/cli/pullboard.js test apps/view/tests/a.js'), 'pullboard test', 'a test run through the CLI is the pullboard test part');
  assert.equal(partOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new'), 'browser tests (Chrome)');
  assert.equal(partOf('node apps/cli/pullboard.js view --port 61916 --no-open'), 'board views');
  assert.equal(partOf('node apps/cli/pullboard.js next --wait'), 'pullboard next (waiting)');
  assert.equal(partOf('node apps/cli/pullboard.js submit 6869 --no-next'), 'pullboard submit');
  assert.equal(partOf('node apps/cli/pullboard.js code:132dd00dc7d05e25b2554cb7 status'), 'pullboard tooling run (commit snapshot)', 'a run from a commit snapshot is one part, not one per commit');
  assert.equal(partOf('git merge-base --is-ancestor main HEAD'), 'git');
  assert.equal(partOf('ssh -x runner-1'), 'ssh to runners');
  assert.equal(partOf('mediaanalysisd'), 'other');
});

test('view.x-io-pipeline-machine.clause-2-cpu-is-averaged-per-part: clause 2: CPU is averaged per part in cores, with the busiest command, and history gives each part\'s average and peak [N26,#6869]', () => {
  const rows = (git, node) => [{ part: 'git', cpu: git, command: 'git status' }, { part: 'other node', cpu: node, command: 'node a.js' }, { part: 'other node', cpu: node / 2, command: 'node b.js' }];
  const parts = aggregateParts([rows(100, 200), rows(300, 400)]);
  assert.deepEqual(parts.map(part => [part.part, part.cores, part.procs, part.command]), [['other node', 4.5, 2, 'node a.js'], ['git', 2, 1, 'git status']], 'cores are the summed percentages over 100 and the samples, busiest part first');

  const sampler = cpuSampler();
  const T = Date.parse('2026-11-13T12:00:00Z');
  assert.deepEqual(sampler.read(T), { samples: 0, minutes: 0, parts: [] }, 'no sample yet: nothing to draw');
  for (let n = 0; n < 6; n++) sampler.add(rows(100, 0), T + n * 10_000);
  for (let n = 0; n < 6; n++) sampler.add(rows(300, 0), T + 60_000 + n * 10_000);
  const read = sampler.read(T + 120_000);
  assert.equal(read.samples, 12);
  assert.equal(read.minutes, 2, 'one history entry per minute sampled');
  const git = read.parts.find(part => part.part === 'git');
  assert.deepEqual([git.now, git.avg, git.peak], [2, 2, 3], 'now is the mean of the samples of the last five minutes; the average and peak are the history\'s one-minute means');
  assert.deepEqual(sampler.read(T + 10 * 60_000).parts.find(part => part.part === 'git').now, 0, 'five idle minutes on, nothing is running now');
  assert.equal(sampler.read(T + 10 * 60_000).parts.find(part => part.part === 'git').peak, 3, 'but the peak is remembered');
});

test('view.x-io-pipeline-machine.clause-2-gate-workers-queues-and-runner: clause 2: gate workers, queues and runner slots come from the machine\'s lease records, and a record it cannot read is null [N26,#6869]', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE resource (name TEXT, capacity INTEGER); CREATE TABLE holder (name TEXT); CREATE TABLE waiter (name TEXT)');
  db.exec("INSERT INTO resource VALUES ('runner:a', 10), ('runner:b', 5), ('runner:off', 0), ('gate', 4)");
  db.exec("INSERT INTO holder VALUES ('submit-handoff-workers'), ('submit-handoff-workers'), ('runner:a'), ('runner:a'), ('runner:b')");
  db.exec("INSERT INTO waiter VALUES ('gate'), ('gate'), ('gate')");
  assert.deepEqual(readLeases(db), { gateWorkers: 2, gateQueued: 3, runnerSlots: 15, runnerUsed: 3 }, 'two workers, three gates waiting, three of fifteen slots');
  db.close();
  assert.equal(queuedTickets(['0001-job-a.json', '0002-job-b.reserved', 'dispatcher.json', 'next-ticket', 'stale-gates']), 2, 'only numbered tickets are queued hand-offs');
  const missing = await machineRead({ resourcesFile: '/nonexistent-pullboard-dir/resources.sqlite', queueDirectory: '/nonexistent-pullboard-dir/queue', repoRoot: '/', now: 2000 });
  assert.deepEqual([missing.gateWorkers, missing.gateQueued, missing.runnerSlots, missing.runnerUsed, missing.handoffQueued], [null, null, null, null, 0], 'no lease records: dashes, and no queue folder means nothing queued');
  assert.equal(missing.cores > 0, true);
  assert.equal(missing.load.length, 3);
  assert.ok(missing.diskFreeGb > 0, 'disk free is read from the machine');
});
