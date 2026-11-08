/** Durable gate 15/20: the hand-off worker is a child calling driveOnce until a terminal step; its death loses nothing [C7]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, jobView } from '../packages/jobs/index.js';
import { drainLoop } from '../packages/drive/index.js';
import { spawnDriveWorker } from '../bin/drive-worker.js';

const files = privateFixtureFiles('pullboard-durable-drive15-');
const repoFiles = privateFixtureFiles('pullboard-drive15-repo-');
after(() => { for (const root of [files.root, repoFiles.root]) rmSync(root, { recursive: true, force: true }); });

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
  files.write('bin/ssh', '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift 2\nexec sh -c "$*"\n');
  chmodSync(join(files.root, 'bin/ssh'), 0o755);
  return { ...process.env, PATH: `${join(files.root, 'bin')}:${process.env.PATH}` };
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
  const board = openBoard(join(files.root, 'loop.sqlite'));
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

test('clause 1: the hand-off worker is a child that drives the job to its verdict, and killing it loses nothing [C7]', async () => {
  const head = seededRepo();
  const env = localSsh();
  const file = join(files.root, 'board.sqlite');
  const seed = openBoard(file);
  try { createJob(seed.db, { id: 'g1', kind: 'gate', candidate: head, base: head, now: 1 }); } finally { closeBoard(seed); }
  const go = join(files.root, 'go');
  const counts = [join(files.root, 'count-s0'), join(files.root, 'count-s1')];
  const plan = [
    { shard: 's0', command: `printf 'run\\n' >> '${counts[0]}'; while [ ! -f '${go}' ]; do sleep 0.05; done; printf zero` },
    { shard: 's1', command: `printf 'run\\n' >> '${counts[1]}'; printf one` },
  ];
  const options = { file, job: 'g1', owner: 'worker-a', repo: repoFiles.root, runner: { host: 'runner-a', root: join(files.root, 'runner') }, plan, intervalMs: 50 };

  const first = spawnDriveWorker(options, { env });
  const killed = await finished(first, (line) => { if (line.startsWith('step running')) first.kill('SIGKILL'); });
  assert.equal(killed.signal, 'SIGKILL', `the first worker dies mid-job: ${killed.stderr}`);
  const read = () => {
    const board = openBoard(file);
    try { return jobView(board.db, 'g1'); } finally { closeBoard(board); }
  };
  assert.ok(read().steps.some(step => step.name === 'running'), 'the dead worker had written its shard plan');
  assert.ok(!read().steps.some(step => step.name === 'verdict'));

  const rival = await finished(spawnDriveWorker({ ...options, owner: 'worker-b' }, { env }));
  assert.equal(rival.code, 3, 'another driver leaves a job whose lease is live alone');

  files.write('go', 'go\n');
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
