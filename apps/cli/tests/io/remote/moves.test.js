/** A seat with board.url set moves a served board through POST /moves and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { checkOutSubmitted } from '../../fixtures/api.js';
import { commitWork } from '../../fixtures/api.js';
import { FIXTURE_BRIEF } from '../../fixtures/api.js';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../fixtures/testkit.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** One successful versioned CLI call on the served board's own checkouts, run in this process. */
async function served(box, cwd, ...args) {
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
function onRemoteSeats(body) {
  return async (t) => {
    const seats = await remoteSeats(t);
    try { await body(seats); } finally { await seats.box.api.close(); }
  };
}

/** A served board with a builder and a verifier seat, and a boardless clone on its own machine home set to its URL. */
async function remoteSeats(t) {
  const box = await apiHttpBox(t);
  // A served claim starts a detached claim beater bound to this test process and queues a detached usage checkpoint;
  // both write under .git/pullboard after the claim returns, so the fixture's removal raced them: ENOTEMPTY. The seats
  // here start neither: no beater, and the checkpoint runs inside the move [P7,C7].
  Object.assign(box.env, { PULLBOARD_CLAIM_BEATER: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline' });
  const builder = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const verifier = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL_EARLIER, '--family', 'claude');
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  // Both homes hold the submit's gate in process and start no detached local runner, so they pin both [P7].
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  for (const home of [box.env.PULLBOARD_MACHINE_HOME, machine]) fixtureMachineSettings(home, { gate: { runnerDispatch: 'controller', localRunner: false } });
  /** Run the real CLI dispatch in the clone as one seat, awaited, so the in-process server keeps answering. */
  const run = (seat, ...args) => runCliInProcess(args,
    { cwd: clone, env: { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: seat.agent } });
  assert.equal((await run(builder, 'settings', 'board.url', box.origin)).status, 0);
  assert.equal((await run(builder, 'settings', 'board.token', '--', box.key)).status, 0);
  /** File one item on the served board from the board host. */
  const add = async (title) => (await served(box, box.root, 'add', 'app', title, '--specs', 'G1', '--criterion', 'Move it by URL', '--brief', FIXTURE_BRIEF)).item.item_id;
  /** The served board's summary row for one item. */
  const row = async (id) => (await box.call(`${box.path}/state`)).document.state.items.find((entry) => entry.id === id);
  return { box, builder, verifier, clone, run, add, row };
}

/** Whether a local board command created or opened a board in the clone. */
function cloneBoard(clone) {
  return existsSync(join(clone, '.git', 'pullboard', 'board.sqlite'));
}

/** Assert one remote command exited 0 and return its JSON result. */
async function moved(seats, seat, ...args) {
  const ran = await seats.run(seat, ...args, '--json');
  assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
  return JSON.parse(ran.stdout);
}

test('next, claim, fact and release from a boardless clone change the served board [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and eight CLI calls, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote movable item');
  const offered = await moved(seats, seats.builder, 'next');
  assert.equal(offered.item.item_id, id, 'next claimed the open item on the served board');
  assert.equal((await seats.row(id)).status, 'claimed');
  await moved(seats, seats.builder, 'fact', String(id), 'note', 'written from another host');
  const { events } = (await seats.box.call(`${seats.box.path}/events`)).document;
  assert.ok(events.some((event) => event.event_kind === 'fact' && JSON.stringify(event).includes('written from another host')), 'the fact reached the served board');
  await moved(seats, seats.builder, 'release', String(id), '--reason', 'OTHER', '--note', 'handing it back');
  assert.equal((await seats.row(id)).status, 'open', 'release reopened the item on the served board');
  const text = await seats.run(seats.builder, 'claim', String(id));
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^claimed #${id}\\b.* via http://`, 'mu'));
  assert.equal((await seats.row(id)).status, 'claimed', 'claim took the item on the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));

test("submit and verify post through /moves and print the served board's result [P7]", { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and six CLI calls, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote reviewed item');
  await moved(seats, seats.builder, 'claim', String(id));
  commitWork(seats.box, seats.builder, id);
  const submitted = await seats.run(seats.builder, 'submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id}\\b.* via http://`, 'mu'));
  assert.equal((await seats.row(id)).status, 'submitted');
  checkOutSubmitted(seats.box, seats.builder, seats.verifier);
  const reserved = await moved(seats, seats.verifier, 'next', '--verify');
  assert.equal(reserved.item.item_id, id, 'next --verify reserved the review on the served board');
  const verdict = await moved(seats, seats.verifier, 'verify', String(id), 'accept', '--reason', 'CRITERION_MET', '--note', 'read the diff by URL');
  assert.equal(verdict.item?.item_id ?? verdict.item_id ?? id, id);
  assert.equal((await seats.row(id)).status, 'verified', 'the verdict reached the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));

/** The refusal code and next: line one CLI run printed. */
function refusalLines(ran) {
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  const code = /^pullboard: \[([A-Z][A-Z0-9_]*)\]/mu.exec(ran.stderr)?.[1];
  const next = /^next: (.+)$/mu.exec(ran.stderr)?.[1];
  assert.ok(code && next, `a refusal with a code and a next step: ${ran.stderr}`);
  return { code, next };
}

test('a move the served board refuses prints the same code and next: line as the local command [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and five CLI calls, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote refused item');
  await moved(seats, seats.builder, 'claim', String(id));
  const remote = refusalLines(await seats.run(seats.verifier, 'claim', String(id)));
  const local = refusalLines(await runCliInProcess(['claim', String(id)], { cwd: seats.verifier.path, env: seats.box.env }));
  assert.deepEqual(remote, local, 'claiming a held item refuses alike by URL and on the board host');
  const json = await seats.run(seats.verifier, 'claim', String(id), '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error.code, local.code, '--json carries the same refusal code');
  assert.equal((await seats.row(id)).status, 'claimed', 'the refused move left the served board as it was');
  assert.equal(cloneBoard(seats.clone), false, 'a refused move opened no local board');
}));
