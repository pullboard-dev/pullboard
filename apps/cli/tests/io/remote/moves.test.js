/** A seat with board.url set moves a served board through POST /moves and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
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
import { startFixtureLocalRunner } from '../../fixtures/runner/local-start.js';
import { whenRunnerSettles } from '../../fixtures/runner/local-start.js';
import { CLI_ENTRY } from '../../fixtures/runner/entry.js';
import { stopFixtureLocalRunner } from '../../fixtures/runner/local-stop.js';
import { sendRemoteHeartbeat } from '../../../src/io/remote/moves.js';

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
    try { await body(seats); } finally { await stopSeats(seats); }
  };
}

/** Stop a served board's local runner and API, so nothing writes into its tree while the fixture removes it. */
async function stopSeats(seats) {
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
function sharedBody(body) {
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
async function remoteSeats(t) {
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
function settledRow(seats, id) {
  return whenRunnerSettles(seats.box.env, async () => { const row = await seats.row(id); return row.status === 'claimed' ? null : row; },
    { deadlineMs: SETTLE_MS, what: `the served gate of #${id}` });
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

test('cli.io-remote-moves.next-claim-fact-and-release-from-a: next, claim, fact and release from a boardless clone change the served board [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and eight CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  // This case holds its claim to the end on a seat of its own, so the shared board's builder stays free for the next cases (a seat holds one item) [P7].
  const mover = await served(seats.box, seats.box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const id = await seats.add('Remote movable item');
  const offered = await moved(seats, mover, 'next');
  assert.equal(offered.item.item_id, id, 'next claimed the open item on the served board');
  assert.equal((await seats.row(id)).status, 'claimed');
  await moved(seats, mover, 'fact', String(id), 'note', 'written from another host');
  const { events } = (await seats.box.call(`${seats.box.path}/events`)).document;
  assert.ok(events.some((event) => event.event_kind === 'fact' && JSON.stringify(event).includes('written from another host')), 'the fact reached the served board');
  await moved(seats, mover, 'release', String(id), '--reason', 'OTHER', '--note', 'handing it back');
  assert.equal((await seats.row(id)).status, 'open', 'release reopened the item on the served board');
  const text = await seats.run(mover, 'claim', String(id));
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^claimed #${id}\\b.* via http://`, 'mu'));
  assert.equal((await seats.row(id)).status, 'claimed', 'claim took the item on the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
  await moved(seats, mover, 'release', String(id), '--reason', 'OTHER', '--note', 'the next case claims its own item');
}));

test('cli.io-remote-moves.submit-and-verify-post-through-moves-and: submit and verify post through /moves and print the served board\'s result [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and six CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  const id = await seats.add('Remote reviewed item');
  await moved(seats, seats.builder, 'claim', String(id));
  commitWork(seats.box, seats.builder, id);
  const submitted = await seats.run(seats.builder, 'submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id}\\b.* via http://`, 'mu'));
  assert.equal((await settledRow(seats, id)).status, 'submitted', 'the host runner posted the pulled gate receipt');
  checkOutSubmitted(seats.box, seats.builder, seats.verifier);
  const reserved = await moved(seats, seats.verifier, 'next', '--verify');
  assert.equal(reserved.item.item_id, id, 'next --verify reserved the review on the served board');
  const verdict = await moved(seats, seats.verifier, 'verify', String(id), 'accept', '--reason', 'CRITERION_MET', '--note', 'read the diff by URL');
  assert.equal(verdict.item?.item_id ?? verdict.item_id ?? id, id);
  assert.equal((await seats.row(id)).status, 'verified', 'the verdict reached the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));

test('cli.io-remote-moves.shout-from-a-boardless-clone-reaches-the: shout from a boardless clone reaches the served board with the seat as sender and opens no local board [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and two CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  const shouted = await moved(seats, seats.builder, 'shout', 'coordinator', '--kind', 'blocker', 'written from another host');
  assert.ok(shouted.id, 'the board answered with the shout id');
  const { shouts } = (await seats.box.call(`${seats.box.path}/state`)).document.state;
  const row = shouts.find((entry) => entry.shout_id === shouted.id);
  assert.equal(row?.shout_from, seats.builder.agent, 'the board records the seat as the sender');
  assert.equal(row?.shout_text, 'written from another host');
  const text = await seats.run(seats.builder, 'shout', 'coordinator', '--kind', 'blocker', 'and in text form');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /^shouted #\d+ via http:\/\//mu);
  assert.equal(cloneBoard(seats.clone), false, 'no shout opened a local board');
}));

/** The refusal code and next: line one CLI run printed. */
function refusalLines(ran) {
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  const code = /^pullboard: \[([A-Z][A-Z0-9_]*)\]/mu.exec(ran.stderr)?.[1];
  const next = /^next: (.+)$/mu.exec(ran.stderr)?.[1];
  assert.ok(code && next, `a refusal with a code and a next step: ${ran.stderr}`);
  return { code, next };
}

test('cli.io-remote-moves.a-move-the-served-board-refuses-prints: a move the served board refuses prints the same code and next: line as the local command [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and five CLI calls, not a throughput claim.
sharedBody(async (seats) => {
  // The holder is a seat of its own, so a slow earlier case that still holds the shared builder cannot turn this refusal into ONE_CLAIM [P7].
  const holder = await served(seats.box, seats.box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const id = await seats.add('Remote refused item');
  await moved(seats, holder, 'claim', String(id));
  const remote = refusalLines(await seats.run(seats.verifier, 'claim', String(id)));
  const local = refusalLines(await runCliInProcess(['claim', String(id)], { cwd: seats.verifier.path, env: seats.box.env }));
  assert.deepEqual(remote, local, 'claiming a held item refuses alike by URL and on the board host');
  const json = await seats.run(seats.verifier, 'claim', String(id), '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error.code, local.code, '--json carries the same refusal code');
  assert.equal((await seats.row(id)).status, 'claimed', 'the refused move left the served board as it was');
  assert.equal(cloneBoard(seats.clone), false, 'a refused move opened no local board');
}));

test('cli.io-remote-moves.a-seat-joined-by-url-claims-commits: clause 1: a seat joined by URL claims, commits in its own clone and submits, exiting 0 with the clone as the source [P7,C7]', { timeout: 120_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and five CLI calls, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote clone item');
  const own = (...args) => runCliInProcess(args, { cwd: seats.clone, env: { ...seats.box.env, PULLBOARD_MACHINE_HOME: seats.machine, PULLBOARD_AGENT: '' } });
  // The commit transport is off by default: this clone opts in, so its submit carries its commits as a bundle [P7,C7].
  assert.equal((await own('settings', 'board.commits', 'bundle')).status, 0);
  const joined = await own('join', 'app', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const claimed = await own('claim', String(id), '--json');
  assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
  mkdirSync(join(seats.clone, 'app'), { recursive: true });
  writeFileSync(join(seats.clone, 'app', `work-${id}.txt`), `work for #${id}\n`);
  runFixtureGit(['add', '-A'], { cwd: seats.clone, env: seats.box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', `feat: fixture work [G1]\n\nPullboard-Item: #${id}`], { cwd: seats.clone, env: seats.box.env, stdio: 'pipe' });
  const submitted = await own('submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id}\\b.* via http://`, 'mu'));
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
}));

test('cli.io-remote-moves.a-claim-by-a-seat-joined-by: a claim by a seat joined by URL opens no item folder on the board host [C7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one join and one claim, not a throughput claim.
onRemoteSeats(async (seats) => {
  const id = await seats.add('Remote folderless item');
  const own = (...args) => runCliInProcess(args, { cwd: seats.clone, env: { ...seats.box.env, PULLBOARD_MACHINE_HOME: seats.machine, PULLBOARD_AGENT: '' } });
  const joined = await own('join', 'app', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const claimed = await own('claim', String(id), '--json');
  assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).itemFolder, undefined, 'the claim result names no item folder');
  assert.equal((await seats.row(id)).status, 'claimed', 'the claim reached the served board');
  const folders = readdirSync(dirname(seats.box.root)).filter((name) => name.endsWith(`-item-${id}`));
  assert.deepEqual(folders, [], 'no item folder appeared beside the board host checkout');
  assert.equal(cloneBoard(seats.clone), false, 'the claim opened no local board');
}));

test('cli.io-remote-moves.heartbeat-posts-the-move: sendRemoteHeartbeat posts {verb: heartbeat, args: {}, agent} to the fixture server /moves and reports a refusal as not held [P7,B3]', async (t) => {
  const posts = [];
  let refuse = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      posts.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(refuse ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(refuse ? { error: { code: 'NOT_HELD', message: 'this seat holds no claim' } } : { result: {} }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const remote = { url: `http://127.0.0.1:${server.address().port}/api/v1/boards/b1`, token: 'k', agent: 'core-9' };
  assert.equal(await sendRemoteHeartbeat(remote), true);
  assert.deepEqual(posts, [{ path: '/api/v1/boards/b1/moves', body: { verb: 'heartbeat', args: {}, agent: 'core-9' } }]);
  refuse = true;
  assert.equal(await sendRemoteHeartbeat(remote), false, 'a refused beat reads as not held');
});
