/** A submit hands a runner its commit through one ticket; the hand-off stages run there, with their lines in its log [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drainHandoffQueue, handoffQueueDirectory } from '../packages/resources/index.js';
import { queueRunnerHandoffTicket, runnerHandoffWanted } from '../apps/cli/src/shell/submit-runner-ticket.js';
import { HANDOFF_STAGES, runHandoffStages } from '../apps/runner/src/shell/runner-handoff-stages.js';
import { runFixtureGit } from './fixture-child.js';

const IDENTITY = ['-c', 'user.name=Ticket Test', '-c', 'user.email=ticket@example.test', '-c', 'commit.gpgsign=false'];
const JOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A real repository with one commit, and a private machine home for the queue. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-ship-commit-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
  const root = join(dir, 'repo');
  mkdirSync(root);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'a\n');
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'one'], { cwd: root });
  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const tree = runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: root }).trim();
  return { dir, root, commit, tree, commonDir: join(root, '.git') };
}

test('clause 1: a runner hand-off queues one ticket naming the commit and starts no worker, checkout or tools copy [C7]', async t => {
  const box = fixture(t);
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('pullboard-handoff-tools-'));
  const name = await queueRunnerHandoffTicket({ root: box.root, commonDir: box.commonDir }, { id: JOB, commit: box.commit, tree: box.tree }, 7);
  const ticket = JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8'));
  assert.equal(ticket.commit, box.commit);
  assert.equal(ticket.kind, 'runner');
  assert.equal(runFixtureGit(['rev-parse', `refs/pullboard/submit-handoffs/${JOB}`], { cwd: box.root }).trim(), box.commit, 'the commit is pinned for the runner to fetch');
  assert.equal(existsSync(join(box.commonDir, 'pullboard', 'submit-handoffs')), false, 'no source directory is made');
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('pullboard-handoff-tools-')), before, 'no tools copy is made');
  // The dispatcher hands the ticket to its runner port and spawns no worker process.
  const handed = [];
  const { started } = await drainHandoffQueue({ pollMs: 20, runnerTicket: async launch => { handed.push(launch.commit); } });
  assert.deepEqual(started, [JOB]);
  assert.deepEqual(handed, [box.commit]);
  assert.deepEqual(readdirSync(handoffQueueDirectory()).filter(file => /^\d+-/u.test(file)), [], 'the ticket is consumed');
  assert.equal(runnerHandoffWanted({ gate: {} }), false, 'with no opt-in or no runner the local worker stays');
});

test('clause 2: the runner runs the six hand-off stages in order and their lines stay in the runner log [C7]', async t => {
  const box = fixture(t);
  const logFile = join(box.dir, 'runner.log');
  const seen = [];
  const stages = Object.fromEntries(HANDOFF_STAGES.map(name => [name, async () => { seen.push(name); }]));
  const result = await runHandoffStages(box.root, { job: JOB, commit: box.commit, tree: box.tree }, { logFile, stages });
  assert.deepEqual(seen, ['authorization', 'doctrine', 'cells', 'composition', 'criterion', 'proof']);
  assert.equal(result.green, true);
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.filter(line => line.includes(' start')).map(line => line.split(' ')[4]), seen);
  assert.equal(JSON.stringify(result).includes('stage '), false, 'the returned result carries no stage line');
  // A real authorization stage refuses a checkout that is not the ticket commit, and later stages never run.
  const wrong = await runHandoffStages(box.root, { job: JOB, commit: 'f'.repeat(40) }, { logFile: join(box.dir, 'wrong.log') });
  assert.equal(wrong.green, false);
  assert.equal(wrong.failed.stage, 'authorization');
  assert.equal(wrong.failed.code, 'RUNNER_SOURCE');
  assert.equal(wrong.stages.length, 1);
});
