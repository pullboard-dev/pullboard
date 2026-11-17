/** gate --withdraw ends the item's gate job row as cancelled when gate.withdrawCancelsJob is on, and leaves it as before when off [C7,#3860]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/** The item's gate job rows, oldest first, read from the board host's connection. */
function gateRows(board, item) {
  return jobsOf(board.db, { kind: 'gate', item });
}

/** One pulled item submitted, its gate job taken by a runner, then withdrawn through the real CLI; returns what the test reads next. */
async function withdrawn(t, gate) {
  const box = await pullProject(t, 1, { gate: { runnerDispatch: 'pull', ...gate } });
  const [id] = box.ids;
  const sent = submitOne(box, id);
  const { board, call } = await pullQueue(t, box);
  const claim = (await call({ action: 'claim', runner: 'runner-w', capabilities: ['node22'] })).claim;
  assert.ok(claim, 'the runner takes the offered gate job');
  const held = { job: claim.job, runner: 'runner-w', token: claim.token };
  const out = box.run(sent.folder, 'gate', '--withdraw', String(id), '--json');
  assert.equal(out.code, 0, `${out.err}\n${out.out}`);
  return { box, id, board, call, held, sent, out };
}

test('clause 1: with gate.withdrawCancelsJob on, gate --withdraw cancels the item\'s gate job row, so a runner status poll reads cancelled [C7,#3860]', async t => {
  const { board, id, call, held, out } = await withdrawn(t, { withdrawCancelsJob: true });
  const rows = gateRows(board, id);
  assert.equal(rows.length, 1, 'the item has the one gate job row');
  assert.equal(rows[0].step, 'cancelled', 'the withdrawn gate\'s job row reads cancelled');
  assert.deepEqual(JSON.parse(out.out).cancelled, [rows[0].id], 'the command names the job it cancelled');
  const renewed = await call({ action: 'renew', ...held }).catch(() => ({ renewed: false }));
  assert.equal(renewed.renewed, false, 'the runner\'s next renew is refused');
});

test('clause 2: a withdrawn gate never posts a verdict later, and a fresh submit of the item starts a new gate at once [C7,#3860]', async t => {
  const { box, id, board, call, held, sent } = await withdrawn(t, { withdrawCancelsJob: true });
  const late = await call({ action: 'receipt', ...held, receipt: { status: 0, gate: { green: true, phases: [] } } }).catch(() => ({ recorded: false }));
  assert.equal(late.recorded, false, 'the cancelled job takes no receipt from its runner');
  const shown = box.run(sent.folder, 'show', String(id), '--json');
  assert.doesNotMatch(shown.out, /"verdict"\s*:\s*"?green/u, 'no verdict was recorded for the withdrawn gate');
  const again = box.run(sent.folder, 'submit', String(id), '--json');
  assert.equal(again.code, 0, `${again.err}\n${again.out}`);
  const live = gateRows(board, id).filter(row => !['done', 'cancelled'].includes(row.step));
  assert.equal(live.length, 1, 'the fresh submit queued one new live gate job');
  assert.notEqual(live[0].id, held.job, 'the new gate job is not the cancelled one');
});

test('clause 3: with gate.withdrawCancelsJob off, gate --withdraw leaves the job row as today [C7,#3860]', async t => {
  const { board, id, out } = await withdrawn(t, { withdrawCancelsJob: false });
  const rows = gateRows(board, id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].step, 'cancelled', 'the job row is not cancelled while the setting is off');
  assert.equal(JSON.parse(out.out).cancelled, undefined, 'the command names no cancelled job');
});
