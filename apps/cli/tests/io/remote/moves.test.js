/** @pullboard-test-input apps/cli/pullboard.js */
/** A seat with board.url set moves a served board through POST /moves and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { checkOutSubmitted } from '../../fixtures/api.js';
import { commitWork } from '../../fixtures/api.js';
import { FIXTURE_BRIEF } from '../../fixtures/api.js';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../fixtures/testkit.js';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** A served board with a builder and a verifier seat, and a boardless clone on its own machine home set to its URL. */
async function remoteSeats(t) {
  const box = await apiHttpBox(t);
  const builder = box.cli(box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const verifier = box.cli(box.root, 'worktree', 'app', '--model', FIXTURE_MODEL_EARLIER, '--family', 'claude');
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  /** Run the real CLI in the clone as one seat without blocking the in-process server. */
  const run = (seat, ...args) => runFixtureChildAsync(process.execPath, [BIN, ...args],
    { cwd: clone, env: { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: seat.agent } });
  assert.equal((await run(builder, 'settings', 'board.url', box.origin)).status, 0);
  assert.equal((await run(builder, 'settings', 'board.token', '--', box.key)).status, 0);
  /** File one item on the served board from the board host. */
  const add = (title) => box.cli(box.root, 'add', 'app', title, '--specs', 'G1', '--criterion', 'Move it by URL', '--brief', FIXTURE_BRIEF).item.item_id;
  /** The served board's detail for one item. */
  const item = async (id) => (await box.call(`${box.path}/items/${id}`)).document.item;
  /** The served board's summary row for one item. */
  const row = async (id) => (await box.call(`${box.path}/state`)).document.state.items.find((entry) => entry.id === id);
  return { box, builder, verifier, clone, run, add, item, row };
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

test('next, claim, fact and release from a boardless clone change the served board [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and eight CLI children, not a throughput claim.
async (t) => {
  const seats = await remoteSeats(t);
  const id = seats.add('Remote movable item');
  const offered = await moved(seats, seats.builder, 'next');
  assert.equal(offered.item.item_id, id, 'next claimed the open item on the served board');
  assert.equal((await seats.row(id)).status, 'claimed');
  await moved(seats, seats.builder, 'fact', String(id), 'note', 'written from another host');
  assert.ok((await seats.item(id)).facts.some((fact) => fact.text === 'written from another host'), 'the fact reached the served board');
  await moved(seats, seats.builder, 'release', String(id), '--reason', 'OTHER', '--note', 'handing it back');
  assert.equal((await seats.row(id)).status, 'open', 'release reopened the item on the served board');
  const text = await seats.run(seats.builder, 'claim', String(id));
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^claimed #${id} Remote movable item via `, 'mu'));
  assert.equal((await seats.row(id)).status, 'claimed', 'claim took the item on the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
});

test("submit and verify post through /moves and print the served board's result [P7]", { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one submit handoff and six CLI children, not a throughput claim.
async (t) => {
  const seats = await remoteSeats(t);
  const id = seats.add('Remote reviewed item');
  await moved(seats, seats.builder, 'claim', String(id));
  commitWork(seats.box, seats.builder, id);
  const submitted = await seats.run(seats.builder, 'submit', String(id));
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  assert.match(submitted.stdout, new RegExp(`^submitted #${id} Remote reviewed item via `, 'mu'));
  assert.equal((await seats.row(id)).status, 'submitted');
  checkOutSubmitted(seats.box, seats.builder, seats.verifier);
  const reserved = await moved(seats, seats.verifier, 'next', '--verify');
  assert.equal(reserved.item.item_id, id, 'next --verify reserved the review on the served board');
  const verdict = await moved(seats, seats.verifier, 'verify', String(id), 'accept', '--reason', 'CRITERION_MET', '--note', 'read the diff by URL');
  assert.equal(verdict.item?.item_id ?? verdict.item_id ?? id, id);
  assert.equal((await seats.row(id)).status, 'verified', 'the verdict reached the served board');
  assert.equal(cloneBoard(seats.clone), false, 'no move opened a local board');
});

/** The refusal code and next: line one CLI run printed. */
function refusalLines(ran) {
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  const code = /^pullboard: \[([A-Z][A-Z0-9_]*)\]/mu.exec(ran.stderr)?.[1];
  const next = /^next: (.+)$/mu.exec(ran.stderr)?.[1];
  assert.ok(code && next, `a refusal with a code and a next step: ${ran.stderr}`);
  return { code, next };
}

test('a move the served board refuses prints the same code and next: line as the local command [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board and five CLI children, not a throughput claim.
async (t) => {
  const seats = await remoteSeats(t);
  const id = seats.add('Remote refused item');
  await moved(seats, seats.builder, 'claim', String(id));
  const remote = refusalLines(await seats.run(seats.verifier, 'claim', String(id)));
  const local = refusalLines(await runFixtureChildAsync(process.execPath, [BIN, 'claim', String(id)], { cwd: seats.verifier.path, env: seats.box.env }));
  assert.deepEqual(remote, local, 'claiming a held item refuses alike by URL and on the board host');
  const json = await seats.run(seats.verifier, 'claim', String(id), '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error.code, local.code, '--json carries the same refusal code');
  assert.equal((await seats.row(id)).status, 'claimed', 'the refused move left the served board as it was');
  assert.equal(cloneBoard(seats.clone), false, 'a refused move opened no local board');
});
