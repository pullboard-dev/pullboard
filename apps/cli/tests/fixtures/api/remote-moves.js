/** The served-board helpers of the remote moves cases: one board on a served API, its seats, and a boardless clone set to its URL [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { apiHttpBox } from '../api.js';
import { FIXTURE_BRIEF } from '../api.js';
import { FIXTURE_MODEL } from '../testkit.js';
import { fixtureMachineSettings } from '../testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../testkit.js';
import { runFixtureGit } from '../child.js';
import { runCliInProcess } from '../process.js';
import { startFixtureLocalRunner } from '../runner/local-start.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { CLI_ENTRY } from '../runner/entry.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';

/** One successful versioned CLI call on the served board's own checkouts, run in this process. */
export async function served(box, cwd, ...args) {
  const ran = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  return JSON.parse(ran.stdout);
}

/**
 * Run one test body on remote seats, then stop the served board before the fixture removes its tree.
 * Why: node:test runs t.after hooks in registration order and the fixture registers its rmSync before the server's close,
 * so the served API (its state materializer and revision watchers write to board.sqlite) was still writing into the tree
 * while it was removed: ENOTEMPTY. Awaiting api.close here ends those writers first; remoteSeats starts no detached ones [P7].
 */
export function onRemoteSeats(body) {
  return async (t) => {
    const seats = await remoteSeats(t);
    try { await body(seats); } finally { await stopSeats(seats); }
  };
}

/** Stop a served board's local runner and API, so nothing writes into its tree while the fixture removes it. */
export async function stopSeats(seats) {
  stopFixtureLocalRunner(seats.box.env.PULLBOARD_MACHINE_HOME);
  await seats.box.api.close();
}

let shared = null;
const sharedCleanups = [];

/**
 * One served board with its seats for the cases that only add items and read their rows, built on first use and torn down after the file.
 * Why: each case used to build its own served board, two worktrees, a clone and a runner, which was most of the file's time; these cases
 * each file their own item, so a shared board changes none of their assertions [P7].
 */
export function sharedBody(body) {
  return async () => {
    shared ??= remoteSeats({ after: (fn) => { sharedCleanups.push(fn); } });
    await body(await shared);
  };
}

after(async () => {
  if (!shared) return;
  try { await stopSeats(await shared); } finally { for (const cleanup of sharedCleanups) await cleanup(); }
});

/** A served board with a builder and a verifier seat, and a boardless clone on its own machine home set to its URL. */
export async function remoteSeats(t) {
  const box = await apiHttpBox(t);
  // A served claim starts a detached claim beater bound to this test process and queues a detached usage checkpoint;
  // both write under .git/pullboard after the claim returns, so the fixture's removal raced them: ENOTEMPTY. The seats
  // here start neither: no beater, and the checkpoint runs inside the move [P7,C7].
  // A landing verdict starts a detached main-red refresh in the cwd of this tree, unless one started within the spacing
  // window: stamp a start now, so none starts and nothing is left writing when the fixture removes its tree [P7,C7].
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'main-red-refresh.started'), String(Date.now()));
  Object.assign(box.env, { PULLBOARD_CLAIM_BEATER: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline' });
  const builder = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const verifier = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL_EARLIER, '--family', 'claude');
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  // The served board's host runs its pulled gate jobs on its own loopback local runner; the boardless clone starts none [P7].
  fixtureMachineSettings(machine, { gate: { localRunner: false } });
  startFixtureLocalRunner(box.env, box.root, { entry: CLI_ENTRY });
  /** Run the real CLI dispatch in the clone as one seat, awaited, so the in-process server keeps answering. */
  const run = (seat, ...args) => runCliInProcess(args,
    { cwd: clone, env: { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: seat.agent } });
  assert.equal((await run(builder, 'settings', 'board.url', box.origin)).status, 0);
  assert.equal((await run(builder, 'settings', 'board.token', '--', box.key)).status, 0);
  /** File one item on the served board from the board host. */
  const add = async (title) => (await served(box, box.root, 'add', 'app', title, '--specs', 'G1', '--criterion', 'Move it by URL', '--brief', FIXTURE_BRIEF)).item.item_id;
  /** The served board's summary row for one item. */
  const row = async (id) => (await box.call(`${box.path}/state`)).document.state.items.find((entry) => entry.id === id);
  return { box, builder, verifier, clone, machine, run, add, row };
}

// Budget: how long the served host's local runner has to pull and settle one gate job; a hang ceiling only.
const SETTLE_MS = 60_000;

/** The item's served row once its pulled gate settled: a pull submit stays claimed until the host's runner posts the receipt [P7]. */
export function settledRow(seats, id) {
  return whenRunnerSettles(seats.box.env, async () => { const row = await seats.row(id); return row.status === 'claimed' ? null : row; },
    { deadlineMs: SETTLE_MS, what: `the served gate of #${id}` });
}

/** Whether a local board command created or opened a board in the clone. */
export function cloneBoard(clone) {
  return existsSync(join(clone, '.git', 'pullboard', 'board.sqlite'));
}

/** Assert one remote command exited 0 and return its JSON result. */
export async function moved(seats, seat, ...args) {
  const ran = await seats.run(seat, ...args, '--json');
  assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
  return JSON.parse(ran.stdout);
}
