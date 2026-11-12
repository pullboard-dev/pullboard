/** A seat whose only held items are submitted is offered new work by next; a red brings it back first [B3,N2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { shout } from '../../../../packages/store/index.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import * as store from '../../../../packages/store/index.js';

/** A fixture whose actor seat holds a claimed item and has a second item open for it. */
async function seatWithClaim(t, { heldGate = false } = {}) {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  let gate;
  if (heldGate) {
    box.advance(Date.now() - box.clock.now().getTime());
    const directory = dirname(box.root);
    const script = join(directory, 'held-gate.cjs');
    gate = { entered: join(directory, 'gate-entered'), release: join(directory, 'gate-release') };
    writeFileSync(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(gate.entered)}, 'entered'); const end = Date.now() + 90000; while (!fs.existsSync(${JSON.stringify(gate.release)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); process.exit(1);\n`);
    const configFile = join(box.root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.gate = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    config.submit = { ...config.submit, handoff: true };
    writeFileSync(configFile, JSON.stringify(config));
    box.git(box.root, 'add', 'pullboard.json');
    box.git(box.root, 'commit', '-q', '-m', 'chore: configure held gate [G1]');
    box.git(seat.path, 'merge', '-q', '--ff-only', 'main');
  }
  const first = box.add('Submitted and waiting on its gate', { brief: 'Files: web/first.js\nTest: submitted work stays the seat\'s own.' });
  const second = box.add('New work offered while the first is checked', { brief: 'Files: web/second.js\nTest: the idle seat builds on.' });
  const claimed = await cli(box, seat.path, ['claim', String(first), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  return { box, seat, first, second, head, tree: box.git(box.root, 'rev-parse', `${head}^{tree}`), gate };
}

test('next offers new work while the seat\'s item is in review [B3,N2]', async t => {
  const { box, seat, first, second, head, tree } = await seatWithClaim(t);
  submitFixture(box.board, first, { agentId: seat.id, commit: head, tree });
  assert.equal(store.getItem(box.board, first).item_status, 'submitted');
  const offered = await cli(box, seat.path, ['next', '--build']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, second, 'a submitted item does not hold the seat idle');
  assert.equal(store.getItem(box.board, first).item_owner, seat.id, 'the submitted item stays the seat\'s own');
});

test('next offers new work while the gate is queued or running, and the red item comes back first [B3,N2]', async t => {
  const context = await seatWithClaim(t, { heldGate: true });
  const { box, seat, first, second, gate } = context;
  mkdirSync(join(seat.path, 'web'), { recursive: true });
  writeFileSync(join(seat.path, 'web/first.js'), 'export const first = true;\n');
  box.git(seat.path, 'add', 'web/first.js');
  box.git(seat.path, 'commit', '-q', '-m', 'feat(web): build first item [G1]');
  store.appendFact(box.board, first, { agentId: seat.id, kind: 'diagnosis', text: 'Files: web/first.js\nChange: build the first item\nTest case: a running gate leaves the seat free for the next item.' });
  // Process-level case, kept: a real submit holds its gate open while the parent runs next.
  const submitted = runFixtureChildAsync(process.execPath, [fileURLToPath(new URL('../../pullboard.js', import.meta.url)), 'submit', String(first), '--no-next', '--json'], { cwd: seat.path, env: { ...process.env }, encoding: 'utf8' });
  try {
    await waitForCondition(() => existsSync(gate.entered), 'the real submit gate enters', { signal: AbortSignal.timeout(60_000) }); // Budget: runaway ceiling for a real runner gate to start.
    const running = store.submitHandoff(box.board, first);
    assert.equal(running?.state, 'running', `the observed gate belongs to a running submit handoff: ${JSON.stringify(running)}`);
  const offered = await cli(box, seat.path, ['next', '--build']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, second, 'a running gate does not hold the seat idle');
  assert.equal(store.getItem(box.board, first).item_status, 'claimed');
  assert.equal(store.getItem(box.board, first).item_owner, seat.id, 'the queued item stays the seat\'s own');
  const release = await cli(box, seat.path, ['release', String(second), '--reason', 'ROUTED_ELSEWHERE', '--no-next']);
  assert.equal(release.code, 0, release.out + release.err);
  writeFileSync(gate.release, 'release');
  await waitForCondition(() => store.submitHandoff(box.board, first)?.state === 'red', 'the real submit gate reports red', { signal: AbortSignal.timeout(60_000) }); // Budget: runaway ceiling for the owned worker to finish.
  const back = await cli(box, seat.path, ['next', '--build']);
  assert.equal(back.code, 0, back.out + back.err);
  assert.equal(back.document.item.item_id, first, 'the red item returns before any new work');
  assert.equal(back.document.held, true);
  } finally {
    writeFileSync(gate.release, 'release');
    await submitted;
  }
});

test('a backlog shout naming a withdrawn item does not end next --wait while the seat has work to be offered [B3,N2]', async t => {
  const { box, seat, first, second } = await seatWithClaim(t);
  const done = box.add('Finished before the shout is read', { brief: 'Files: web/done.js\nTest: finished work asks nothing.' });
  shout(box.board, { from: 'coordinator', to: seat.id, text: `fix #${done} before the review lands, the owner asked`, lanes: ['web', 'review', 'docs'] });
  store.withdraw(box.board, done, { agentId: 'coordinator', reason: 'finished before the shout' });
  const offered = await cli(box, seat.path, ['next', '--build', '--wait', '1']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.notEqual(offered.document.item.item_id, done, 'the withdrawn item is not offered');
  assert.ok([first, second].includes(offered.document.item.item_id), 'the seat is offered its own or new work');
}
);
