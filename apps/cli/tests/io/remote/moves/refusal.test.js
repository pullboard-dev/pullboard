/** A boardless clone's shout and a refused move reach the served board and print the local command's refusal [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../fixtures/testkit.js';
import { runCliInProcess } from '../../../fixtures/process.js';
import { cloneBoard } from '../../../fixtures/api/remote-moves.js';
import { moved } from '../../../fixtures/api/remote-moves.js';
import { served } from '../../../fixtures/api/remote-moves.js';
import { sharedBody } from '../../../fixtures/api/remote-moves.js';

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
