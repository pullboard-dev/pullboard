/** Durable gate 12/20: driveOnce continues a job from its last written step; a resumed job skips done shards [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { startFixtureChild } from '../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { treeOf } from '../../../../packages/pin/index.js';
import { writeToolingPin } from '../../../../packages/pin/index.js';
import { createTransport } from '../../../../packages/transport/index.js';
import { shellWord } from '../../../../packages/transport/index.js';
import { driveOnce } from '../../../../packages/drive/index.js';
import { rmSync } from 'node:fs';
import { jobView } from '../../../../packages/jobs/index.js';
import {
  chmodSync,
  readFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { drainLoop } from '../../../../packages/drive/index.js';
import { spawnDriveWorker } from '../../src/io/drive/worker.js';

after(cleanupFixtureChildren);

/** A transport whose runner shell is a real local `sh`. */
function localTransport() {
  return createTransport({
    open: () => startFixtureChild('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
    launch: (runner, script) => startFixtureChild('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
}

/** A repo with a seat's older commit and a newer landed commit whose tree is the tooling pin. */
function pinnedRepo() {
  const files = privateFixtureFiles('pullboard-drive12-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'drive@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Drive Test']);
  files.write('tool.txt', 'seat tooling\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'seat']);
  const seat = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('tool.txt', 'main tooling\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'landed']);
  const landed = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  writeToolingPin(repo, landed);
  return { repo, seat, landed };
}

/** Ask the runner's own shell to wait, bounded, until the shard's result file exists. */
async function resultWritten(transport, runner, job, shard) {
  const file = `${runner.root}/transport/jobs/${job}/${shard}/result`;
  const reply = await transport.connect(runner).run(`i=0; while [ ! -f ${shellWord(file)} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -f ${shellWord(file)} ]`);
  assert.equal(reply.status, 0, `no result file at ${file}`);
}

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const files = privateFixtureFiles('pullboard-drive12-board-');
  const board = openBoard(':memory:');
  try { return await body(board.db, files.root); } finally { closeBoard(board); }
}

test('clause 1: given a job at any step, driveOnce performs the next transition and writes it [C7]', { skip: 'CONTROLLER_ONLY: deleted with #7526 (the detached SSH-adapter shard worker never writes its result file inside a pulled runner job)' }, async () => {
  const { repo, seat, landed } = pinnedRepo();
  const transport = localTransport();
  try {
    await withBoard(async (db, root) => {
      const runner = { host: 'runner-a', root: join(root, 'runner') };
      const plan = [{ shard: 's0', command: 'printf zero' }, { shard: 's1', command: 'printf one' }];
      createJob(db, { id: 'g1', kind: 'gate', candidate: seat, base: landed, now: 1 });
      let clock = 10_000;
      const drive = () => driveOnce(db, 'g1', { owner: 'driver-a', repo, runner, plan, transport, now: () => clock });

      const captured = await drive();
      assert.equal(captured.transition, 'captured');
      const pin = captured.job.steps.at(-1);
      assert.equal(pin.name, 'captured');
      assert.equal(pin.payload.tree, treeOf(repo, seat), 'the source is the seat commit tree');
      assert.equal(pin.payload.tooling, treeOf(repo, landed), 'tooling comes from toolingFor: the last landing, not the seat checkout');
      assert.equal(pin.payload.pinned, true);
      assert.equal(pin.payload.base, treeOf(repo, landed));

      clock += 1000;
      const running = await drive();
      assert.equal(running.transition, 'running');
      assert.deepEqual(running.job.steps.filter(s => s.name === 'shard.started').map(s => s.payload), [
        { shard: 's0', runner: 'runner-a' }, { shard: 's1', runner: 'runner-a' }]);
      assert.deepEqual(running.job.steps.find(s => s.name === 'running').payload.shards, plan, 'the plan is written before any shard starts');

      await resultWritten(transport, runner, 'g1', 's0');
      await resultWritten(transport, runner, 'g1', 's1');
      clock += 1000;
      const collected = await drive();
      assert.equal(collected.transition, 'collected');
      assert.deepEqual(Object.keys(collected.job.steps.at(-1).payload.shards).sort(), ['s0', 's1']);
      assert.equal(collected.job.steps.filter(s => s.name === 'shard.done').length, 2);

      clock += 1000;
      const verdict = await drive();
      assert.equal(verdict.transition, 'verdict');
      const step = verdict.job.steps.at(-1);
      assert.equal(step.name, 'verdict');
      assert.equal(step.payload.verdict, 'green');
      assert.equal(step.payload.receipt, `${treeOf(repo, seat)}@${treeOf(repo, landed)}`);

      const terminal = await drive();
      assert.equal(terminal.transition, null, 'a job at its verdict is terminal');
      assert.equal(terminal.job.steps.length, verdict.job.steps.length, 'nothing more is written');
    });
  } finally { transport.close(); }
});

test('clause 1: a resumed job skips done shards and another driver\'s live lease is left alone [C7]', { skip: 'CONTROLLER_ONLY: deleted with #7526 (the detached SSH-adapter shard worker never writes its result file inside a pulled runner job)' }, async () => {
  const { repo, seat } = pinnedRepo();
  const transport = localTransport();
  try {
    await withBoard(async (db, root) => {
      const runner = { host: 'runner-a', root: join(root, 'runner') };
      const ran = shard => join(root, `${shard}.ran`);
      const shards = ['s0', 's1', 's2'].map(shard => ({ shard, command: `printf x >> ${shellWord(ran(shard))}; [ ${shard} != s2 ]` }));
      createJob(db, { id: 'g2', kind: 'gate', candidate: seat, now: 1 });
      takeJob(db, 'g2', 'dead-driver', { now: 1000 });
      writeStep(db, 'g2', 'captured', { tree: treeOf(repo, seat), tooling: treeOf(repo, seat), pinned: false, base: null }, { now: 1000 });
      writeStep(db, 'g2', 'running', { runner, shards }, { now: 1000 });
      writeStep(db, 'g2', 'shard.started', { shard: 's0', runner: 'runner-a' }, { seq: 0, now: 1000 });
      writeStep(db, 'g2', 'shard.done', { shard: 's0', status: 0, digest: 'd'.repeat(64) }, { seq: 0, now: 1000 });

      const blocked = await driveOnce(db, 'g2', { owner: 'driver-b', transport, now: () => 1000 + LEASE_MS - 1 });
      assert.equal(blocked.code, 'JOB_LEASED', 'a live lease held by another driver is never taken');
      assert.equal(blocked.transition, null);

      const resumed = await driveOnce(db, 'g2', { owner: 'driver-b', transport, now: () => 1000 + LEASE_MS + 1 });
      assert.equal(resumed.job.leaseOwner, 'driver-b', 'the lapsed lease moved to the resuming driver');
      assert.equal(resumed.owed, 2);
      assert.deepEqual(resumed.job.steps.filter(s => s.name === 'shard.started').map(s => s.payload.shard).sort(), ['s0', 's1', 's2']);

      await resultWritten(transport, runner, 'g2', 's1');
      await resultWritten(transport, runner, 'g2', 's2');
      const collected = await driveOnce(db, 'g2', { owner: 'driver-b', transport, now: () => 1000 + LEASE_MS + 2 });
      assert.equal(collected.transition, 'collected');
      assert.equal(existsSync(ran('s0')), false, 'the done shard was never started again');
      assert.equal(existsSync(ran('s1')), true);
      assert.deepEqual(collected.job.steps.at(-1).payload.shards.s0, { status: 0, digest: 'd'.repeat(64) }, 's0 keeps its recorded result');
      assert.equal(collected.job.steps.at(-1).payload.shards.s2.status, 1);

      const verdict = await driveOnce(db, 'g2', { owner: 'driver-b', transport, now: () => 1000 + LEASE_MS + 3 });
      assert.equal(verdict.job.steps.at(-1).payload.verdict, 'red', 'a failing shard judges red');
      assert.match(verdict.job.steps.at(-1).payload.code, /s2/u);
    });
  } finally { transport.close(); }
});

test('clause 1: driveOnce refuses with a code when a transition lacks what it needs [C7]', async () => {
  await withBoard(async (db) => {
    createJob(db, { id: 'g3', kind: 'gate', now: 1 });
    await assert.rejects(driveOnce(db, 'g3', {}), { code: 'DRIVE_OWNER' });
    await assert.rejects(driveOnce(db, 'none', { owner: 'a' }), { code: 'JOB_MISSING' });
    await assert.rejects(driveOnce(db, 'g3', { owner: 'a', repo: '/nowhere', now: () => 5 }), { code: 'DRIVE_CANDIDATE' });
  });
});

const files = privateFixtureFiles('pullboard-durable-drive-');
after(() => rmSync(files.root, { recursive: true, force: true }));

const filesPart3 = privateFixtureFiles('pullboard-durable-drive15-');
const repoFiles = privateFixtureFiles('pullboard-drive15-repo-');
after(() => { for (const root of [filesPart3.root, repoFiles.root]) rmSync(root, { recursive: true, force: true }); });

/** A real repository with one commit; returns its head. */
function seededRepo() {
  const repo = repoFiles.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'drive@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Drive Test']);
  repoFiles.write('tool.txt', 'tooling\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'seed']);
  return runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
}

/** An `ssh` on PATH that runs the remote command in a local `sh`, so the worker's real SSH adapter has a runner. */
function localSsh() {
  filesPart3.write('bin/ssh', '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift 2\nexec sh -c "$*"\n');
  chmodSync(join(filesPart3.root, 'bin/ssh'), 0o755);
  return { ...process.env, PATH: `${join(filesPart3.root, 'bin')}:${process.env.PATH}` };
}

/** Resolve with the child's exit once it closes, collecting its stdout lines and calling `onLine` on each. */
function finished(child, onLine = () => {}) {
  const lines = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(line); onLine(line); });
  return new Promise((done) => child.once('close', (code, signal) => done({ code, signal, lines, stderr })));
}

test('clause 1: drainLoop calls driveOnce until the job reaches its terminal step [C7]', async () => {
  const board = openBoard(':memory:');
  try {
    createJob(board.db, { id: 'loop', kind: 'gate', now: 1 });
    const phases = ['captured', 'running', 'running', 'collected', 'verdict'];
    const calls = [];
    const drive = async (db, job, options) => {
      calls.push(options.owner);
      const phase = phases[calls.length - 1];
      return { transition: phase === phases[calls.length - 2] ? null : phase, phase, job: jobView(db, job) };
    };
    const last = await drainLoop(board.db, 'loop', { owner: 'w', drive, intervalMs: 1 });
    assert.equal(last.phase, 'verdict');
    assert.deepEqual(calls, ['w', 'w', 'w', 'w', 'w'], 'one driveOnce per step, resting only when a call moved nothing');
    const leased = await drainLoop(board.db, 'loop', { owner: 'w', drive: async () => ({ transition: null, phase: 'running', code: 'JOB_LEASED' }) });
    assert.equal(leased.code, 'JOB_LEASED', 'a loop stops when another driver holds the live lease');
  } finally { closeBoard(board); }
});

test('clause 1: the hand-off worker is a child that drives the job to its verdict, and killing it loses nothing [C7]', { skip: 'CONTROLLER_ONLY: deleted with #7526 (the SSH stand-in hand-off worker and its detached shards never finish inside a pulled runner job)' }, async () => {
  const head = seededRepo();
  const env = localSsh();
  const file = join(filesPart3.root, 'board.sqlite');
  // @pullboard-board-file persistence: a killed worker process and this seed share one board file
  const seed = openBoard(file);
  try { createJob(seed.db, { id: 'g1', kind: 'gate', candidate: head, base: head, now: 1 }); } finally { closeBoard(seed); }
  const go = join(filesPart3.root, 'go');
  const counts = [join(filesPart3.root, 'count-s0'), join(filesPart3.root, 'count-s1')];
  const plan = [
    { shard: 's0', command: `printf 'run\\n' >> '${counts[0]}'; while [ ! -f '${go}' ]; do sleep 0.05; done; printf zero` },
    { shard: 's1', command: `printf 'run\\n' >> '${counts[1]}'; printf one` },
  ];
  const options = { file, job: 'g1', owner: 'worker-a', repo: repoFiles.root, runner: { host: 'runner-a', root: join(filesPart3.root, 'runner') }, plan, intervalMs: 50 };

  const first = spawnDriveWorker(options, { env });
  const killed = await finished(first, (line) => { if (line.startsWith('step running')) first.kill('SIGKILL'); });
  assert.equal(killed.signal, 'SIGKILL', `the first worker dies mid-job: ${killed.stderr}`);
  const read = () => {
    // @pullboard-board-file persistence: a killed worker process and this seed share one board file
    const board = openBoard(file);
    try { return jobView(board.db, 'g1'); } finally { closeBoard(board); }
  };
  assert.ok(read().steps.some(step => step.name === 'running'), 'the dead worker had written its shard plan');
  assert.ok(!read().steps.some(step => step.name === 'verdict'));

  const rival = await finished(spawnDriveWorker({ ...options, owner: 'worker-b' }, { env }));
  assert.equal(rival.code, 3, 'another driver leaves a job whose lease is live alone');

  filesPart3.write('go', 'go\n');
  const second = await finished(spawnDriveWorker(options, { env }));
  assert.equal(second.code, 0, `the respawned worker finishes the job: ${second.stderr}`);
  assert.equal(second.lines.at(-1), 'step verdict verdict', 'the child drives until the terminal step');

  const job = read();
  const named = name => job.steps.filter(step => step.name === name).length;
  assert.deepEqual([named('captured'), named('running'), named('collected'), named('verdict')], [1, 1, 1, 1], 'each step is written once across both workers');
  assert.deepEqual(job.steps.filter(step => step.name === 'shard.done').map(step => step.payload.shard).sort(), ['s0', 's1']);
  for (const count of counts) {
    assert.ok(existsSync(count));
    assert.equal(readFileSync(count, 'utf8'), 'run\n', 'no shard ran twice: the death lost nothing and the resume reran nothing');
  }
});
