/** A machine with no registered runners is its own runner: a pull submit starts one local runner serve on loopback, which gates and lands; a remote runner added later only adds capacity [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../lib/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

const GATE = { runnerDispatch: 'pull', localRunner: true };
// A runner's checkout is a worktree whose .git is a file, so the stand-in parts record nothing; the gate's receipt is the record.
const RECORD = 'export function record() {}\n';
// The proof holds while the FIXTURE_HOLD file names a path this checkout has, so one runner can be kept busy on purpose.
const PROOF = `import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
const hold = process.env.FIXTURE_HOLD;
const held = () => { try { return hold && existsSync(hold) && existsSync(readFileSync(hold, 'utf8').trim()); } catch { return false; } };
while (held()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
`;

/** Read the board through a short connection, as another process reads a board the runner writes. */
function read(box, work) {
  // @pullboard-board-file journey: the test reads the board the local runner writes, as any second process would.
  const board = openKitBoard(box.boardFile, undefined, { gitRoot: box.repo });
  try { return work(board); } finally { closeBoard(board); }
}

/**
 * Wait for a condition on the board, checked again each time the local runner folder changes: its log takes a line on
 * every claim and receipt, and its state file a heartbeat every 5 s. The test's timeout is the ceiling.
 */
function until(box, check) {
  return new Promise(done => {
    let watcher = null;
    const probe = () => {
      let value = null;
      try { value = read(box, check); } catch { /* the runner holds the board lock; the next change probes again */ }
      if (!value) return false;
      watcher?.close();
      done(value);
      return true;
    };
    if (!probe()) watcher = watch(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner'), probe);
  });
}

/** The runner that posted a job's receipt. */
function receiptRunner(board, kind, item) {
  const job = jobsOf(board.db, { kind, ...(item ? { item } : {}) }).at(-1);
  return job?.step === 'done' ? job.steps.find(step => step.name === 'receipt')?.payload.runner ?? null : null;
}

/** The machine's local runner state file, or null. */
function runnerState(box) {
  try { return JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'state.json'), 'utf8')); } catch { return null; }
}

/** True while the pid exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Run the automatic lander's own entry, as a landing wake does, in a child process at the main checkout. */
function landAfterAccept(box) {
  const source = [
    `import { wakeIo } from ${JSON.stringify(new URL('../../src/io/landing/automatic.js', import.meta.url).href)};`,
    `import { context, landAfterAcceptance } from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};`,
    'console.log("RESULT " + JSON.stringify(await landAfterAcceptance(context(wakeIo(process.argv[1])))));',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
}

/** A pull project with zero registered runners, the local runner on, no trunk remote, and automatic landing on. */
async function soloBoard(t) {
  const box = await pullProject(t, 4, { gate: GATE, tooling: { 'bin/record.js': RECORD, 'bin/proof.js': PROOF } });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.trunk?.remote ?? '', '', 'trunk.remote is empty: trunk is the board host\'s repository');
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: land automatically [G1]');
  box.env.FIXTURE_HOLD = join(box.dir, 'hold');
  // The sandbox is gone by the time this runs, so only the processes the journey saw are stopped here.
  box.pids = new Set();
  t.after(() => { for (const pid of box.pids) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return box;
}

/** The journey's error with the local runner's log appended, so a red run shows what the runner saw. */
function withLog(box, error) {
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log');
  if (existsSync(log)) error.message += `\nlocal runner log:\n${readFileSync(log, 'utf8').slice(-4000)}`;
  return error;
}

test('clauses 1-3: zero runners, init to land on the local runner; it restarts when killed, a remote runner later shares the jobs, and --off stops it cleanly [P7]', { timeout: 420_000 }, // budget: hang ceiling for a project, four pulled gates, a landing and a runner restart.
async t => {
  const box = await soloBoard(t);
  try { await journey(t, box); } catch (error) { throw withLog(box, error); }
});

/** Init to land with zero runners, a restart, a remote runner added later, and a clean stop. */
async function journey(t, box) {
  const [first, second, third, fourth] = box.ids;

  // Clause 1: the first submit starts the one local runner, and its gate runs and posts its receipt through it.
  const one = submitOne(box, first);
  assert.equal(one.document.queued, true);
  assert.equal(one.document.localRunner?.started, true, JSON.stringify(one.document));
  const pid = one.document.localRunner.pid;
  box.pids.add(pid);
  await until(box, board => getItem(board, first).item_status === 'submitted');
  const local = read(box, board => receiptRunner(board, 'gate', first));
  assert.match(local, /^local-/u, 'the local runner posted the gate receipt');
  assert.equal(read(box, board => jobsOf(board.db, { kind: 'gate', item: first })[0].steps.find(step => step.name === 'receipt').payload.receipt.gate.green), true);
  assert.match(runnerState(box).url, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/boards$/u, 'it serves the board API on loopback');

  // Clause 1: one per machine, and restarted when it dies.
  process.kill(pid, 'SIGKILL');
  // SIGKILL ends it at once; spin the few microseconds until the pid is gone, so the next submit sees it dead.
  for (let n = 0; alive(pid) && n < 10_000_000; n++) { /* spin */ }
  assert.equal(alive(pid), false, 'the killed local runner is gone');
  const two = submitOne(box, second);
  assert.equal(two.document.localRunner?.started, true, 'the next submit starts it again');
  assert.notEqual(two.document.localRunner.pid, pid);
  box.pids.add(two.document.localRunner.pid);
  await until(box, board => getItem(board, second).item_status === 'submitted');
  assert.match(read(box, board => receiptRunner(board, 'gate', second)), new RegExp(`^local-.+-${two.document.localRunner.pid}$`, 'u'), 'the restarted runner posted it');

  // Clause 2: an accepted item lands through a local land job, with no runner registered, into the board host's checkout.
  const before = box.git(box.repo, 'rev-parse', 'main');
  read(box, board => verify(board, first, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance of a gated item', head: one.commit,
    digest: getItem(board, first).item_frozen_digest, policy: 'any' }));
  const offered = landAfterAccept(box);
  assert.match(String(offered.offered), /^land:/u, JSON.stringify(offered));
  const merged = await until(box, board => getItem(board, first).item_merged_commit);
  assert.match(read(box, board => receiptRunner(board, 'land')), /^local-/u, 'the local runner took the land job');
  assert.equal(read(box, board => jobsOf(board.db, { kind: 'land' })[0].steps.find(step => step.name === 'offered').payload.needs).join(), 'board-host');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), merged, 'main is the pushed merge');
  assert.deepEqual(box.git(box.repo, 'rev-list', '--parents', '-n', '1', merged).split(' ').slice(1), [before, one.commit]);
  assert.equal(readFileSync(join(box.repo, 'web', `${first}.txt`), 'utf8'), `gate ${first}\n`, 'the board host\'s work tree has the landed file');
  assert.equal(box.git(box.repo, 'status', '--porcelain', '--untracked-files=no'), '');

  // Clause 3: a remote runner registered later needs no change to the local one, and both take jobs.
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: GATE, runners: [{ host: 'remote-a', slots: 1, browser: 0, node: process.execPath }] });
  writeFileSync(box.env.FIXTURE_HOLD, `web/${third}.txt`);
  const three = submitOne(box, third);
  assert.deepEqual([three.document.localRunner?.started, three.document.localRunner?.pid], [false, two.document.localRunner.pid], 'the local runner runs on unchanged');
  await until(box, board => /^local-/u.test(board.db.prepare("SELECT job_lease_owner AS owner FROM job WHERE job_kind = 'gate' AND job_item = ?").get(third)?.owner ?? ''));
  submitOne(box, fourth);
  const remote = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const served = await serveOnce(box, remote.url, 'remote-a', { FIXTURE_HOLD: box.env.FIXTURE_HOLD });
  assert.equal(served.code, 0, served.output);
  rmSync(box.env.FIXTURE_HOLD);
  await until(box, board => [third, fourth].every(id => getItem(board, id).item_status === 'submitted'));
  assert.deepEqual(read(box, board => [receiptRunner(board, 'gate', third), receiptRunner(board, 'gate', fourth)]).map(runner => runner.replace(/^local-.*$/u, 'local')),
    ['local', 'remote-a'], 'both runners took a job');

  // Stopped cleanly: --off waits for it to exit and leaves no state behind.
  const live = runnerState(box).pid;
  const off = box.run(box.repo, 'runner', 'local', '--off', '--json');
  assert.equal(off.code, 0, off.err);
  const answer = JSON.parse(off.out);
  assert.deepEqual([answer.stopped, answer.pid], [true, live]);
  assert.equal(alive(live), false);
  assert.equal(runnerState(box), null);
}
