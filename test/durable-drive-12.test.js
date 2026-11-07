/** Durable gate 12/20: driveOnce continues a job from its last written step; a resumed job skips done shards [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, privateFixtureFiles, runFixtureGit, startFixtureChild } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, takeJob, writeStep, LEASE_MS } from '../packages/jobs/index.js';
import { treeOf, writeToolingPin } from '../packages/pin/index.js';
import { createTransport, shellWord } from '../packages/transport/index.js';
import { driveOnce } from '../packages/drive/index.js';

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
  const board = openBoard(join(files.root, 'board.sqlite'));
  try { return await body(board.db, files.root); } finally { closeBoard(board); }
}

test('clause 1: given a job at any step, driveOnce performs the next transition and writes it [C7]', async () => {
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

test('clause 1: a resumed job skips done shards and another driver\'s live lease is left alone [C7]', async () => {
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
