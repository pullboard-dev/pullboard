/** A submit hands a runner its commit through one ticket; the hand-off stages run there, with their lines in its log [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_DISPATCHER_RESOURCE } from '../packages/resources/index.js';
import { drainHandoffQueue } from '../packages/resources/index.js';
import { handoffQueueDirectory } from '../packages/resources/index.js';
import { queueHandoffLaunch } from '../packages/resources/index.js';
import { reserveHandoffTicket } from '../packages/resources/index.js';
import { takeResource } from '../packages/resources/index.js';
import { openBoard } from '../apps/lib/index.js';
import { submitHandoff } from '../packages/store/index.js';
import { dispatchRunnerTicket } from '../apps/cli/src/shell/submit-runner-dispatch.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { execFileSync } from 'node:child_process';
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

test('clause 2: the runner-side stage runner runs the six hand-off stages in order and their lines stay in the runner log [C7]', async t => {
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

const RUNNER = { host: 'ticket@runner-one', slots: 4, browser: 1, node: '/usr/bin/node' };

/** A real project and board whose machine settings register one runner, with the dispatcher seat held so nothing drains. */
async function submitted(t, handoffSetting) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const home = isolated.env.PULLBOARD_MACHINE_HOME;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gate: { runnerHandoff: handoffSetting }, runners: [RUNNER] }));
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Ship the commit', '--specs', 'G1', '--criterion', 'The commit ships.', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/ship.txt', 'ship\n', 'feat(web): ship candidate [G1]').status, 0);
  const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'test-dispatcher' });
  t.after(() => lock.release());
  const run = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let job;
  try { job = submitHandoff(board, id); } finally { board.db.close(); }
  const tickets = readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name))
    .map(name => JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8')));
  return { box, job, tickets, directory: join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id) };
}

test('clause 1: a real submit with gate.runnerHandoff on and a runner registered queues one ticket naming the commit and leaves no worker, source or tools copy [C7]', async t => {
  const run = await submitted(t, true);
  assert.equal(run.job.state, 'queued', 'the submission is recorded on the board');
  assert.equal(run.tickets.length, 1);
  assert.equal(run.tickets[0].kind, 'runner');
  assert.equal(run.tickets[0].commit, run.job.commit, 'the ticket names the submitted commit hash');
  assert.equal(run.box.git(run.box.repo, 'rev-parse', `refs/pullboard/submit-handoffs/${run.job.id}`).trim(), run.job.commit, 'the commit is pinned for the runner');
  assert.equal(existsSync(join(run.directory, 'source')), false, 'no source checkout');
  assert.equal(existsSync(join(run.directory, 'request.json')), false, 'no worker request or tools copy');
  const processes = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  assert.equal(processes.includes(run.job.id), false, 'no worker process for the job survives the submit');
});

test('clause 1: with gate.runnerHandoff off a real submit still prepares the local worker: a source checkout, a request and a local ticket [C7]', async t => {
  const run = await submitted(t, false);
  assert.equal(run.job.state, 'queued');
  assert.equal(existsSync(join(run.directory, 'request.json')), true, 'the local worker request is written');
  assert.equal(run.tickets.length, 1);
  assert.notEqual(run.tickets[0].kind, 'runner');
  assert.equal(typeof run.tickets[0].tools, 'string', 'the local ticket carries its captured tools');
});

test('clause 2: the dispatcher sends a runner ticket to a registered runner, records the job start and runner in the hand-off folder, and spawns no worker [C7]', async t => {
  const box = fixture(t);
  const ticket = { kind: 'runner', job: JOB, item: 7, commit: box.commit, tree: box.tree, main: box.commit, root: box.root, commonDir: box.commonDir };
  const calls = [];
  const run = async (root, command, options) => { calls.push({ root, command, options }); return {}; };
  const done = await dispatchRunnerTicket(ticket, { settings: { runners: [RUNNER] }, run });
  assert.deepEqual(done, { runner: RUNNER.host });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.runner.host, RUNNER.host);
  assert.deepEqual(calls[0].options.checkedSource, { commit: box.commit, tree: box.tree }, 'the runner is handed exactly the ticket commit');
  const record = JSON.parse(readFileSync(join(box.commonDir, 'pullboard', 'submit-handoffs', JOB, 'runner.json'), 'utf8'));
  assert.equal(record.runner, RUNNER.host);
  assert.equal(record.job, JOB);
  assert.ok(Date.parse(record.started) > 0, 'the start time is recorded');
  assert.equal(existsSync(handoffQueueDirectory()), false, 'a delivered ticket is not queued again');
  assert.equal(existsSync(join(box.commonDir, 'pullboard', 'submit-handoffs', JOB, 'worker.json')), false, 'no local worker record');
});

test('clause 2: a ticket with no reachable runner is requeued, never dropped, and waits out its retry delay [C7]', async t => {
  const box = fixture(t);
  const ticket = { kind: 'runner', job: JOB, item: 7, commit: box.commit, tree: box.tree, main: box.commit, root: box.root, commonDir: box.commonDir };
  const down = async () => { throw Object.assign(new Error('connection refused'), { code: 'RUNNER_DROPPED' }); };
  const now = Date.now();
  const none = await dispatchRunnerTicket(ticket, { settings: { runners: [] }, run: down, now: () => now });
  assert.deepEqual(none, { requeued: true }, 'with no runner registered');
  const unreachable = await dispatchRunnerTicket({ ...ticket, attempts: 1 }, { settings: { runners: [RUNNER] }, run: down, now: () => now, retryMs: 60_000 });
  assert.deepEqual(unreachable, { requeued: true }, 'with a runner that fails');
  const queued = readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name)).map(name => JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8')));
  assert.equal(queued.length, 2, 'both tickets are back in line');
  assert.equal(queued[1].attempts, 2);
  assert.equal(queued[1].notBefore, now + 60_000);
  assert.match(queued[1].lastFailure, /RUNNER_DROPPED/u);
  assert.equal(queued[1].commit, box.commit);
  // The dispatcher leaves a ticket inside its retry delay alone rather than hand it out again at once.
  for (const name of readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name))) rmSync(join(handoffQueueDirectory(), name));
  const place = await reserveHandoffTicket(JOB);
  queueHandoffLaunch({ ...ticket, notBefore: Date.now() + 400 }, place);
  const handed = [];
  await drainHandoffQueue({ pollMs: 20, runnerTicket: async launch => { handed.push(Date.now()); } });
  assert.equal(handed.length, 1);
  assert.ok(handed[0] >= now, 'the ticket was handed out once, after its delay');
});
