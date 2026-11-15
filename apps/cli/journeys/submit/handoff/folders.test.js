/** Pulled submissions from two item folders stay bound to their own claims and sources [B5,V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import {
  document,
  fixture,
  gateJob,
  state,
} from '../../../tests/fixtures/submit/handoff.js';
import { settledGateJob } from '../../../tests/fixtures/submit/settle.js';

test('two item folders stamp and queue their own claims while the first gate runs [B5,V4]', async t => {
  const box = fixture(t, { firstFolder: true });
  // The first gate holds on its release file while the second folder submits, so no submit waits for the queue to settle.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  assert.match(box.git(box.source, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  assert.match(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.second}\\b`));
  assert.doesNotMatch(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  const marker = box.git(box.source, 'rev-parse', '--git-path', 'pullboard-item.json');
  rmSync(marker);
  document((await box.runLocal(box.source, 'status', '--json')));
  const restored = `${JSON.stringify({ version: 1, seat: state(box, box.id).item.item_owner, item: box.id })}\n`;
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(restored)}\0${restored}`).digest('hex');
  assert.equal(box.git(box.source, 'hash-object', marker), blob, 'pre-marker folder restores its own private identity');
  writeFileSync(marker, '{broken');
  assert.equal((await box.runLocal(box.source, 'status', '--json')).code, 1, 'a damaged marker is never silently replaced');
  rmSync(marker);
  for (const command of [['status'], ['inbox'], ['show', String(box.id)]]) document((await box.runLocal(box.source, ...command, '--json')));
  const renewed = document((await box.runLocal(box.source, 'claim', String(box.id), '--json')));
  assert.equal(renewed.itemFolder, box.source, 'renewing inside the folder reopens the same folder beside the seat');
  const first = document((await box.runLocal(box.source, 'submit', String(box.id), '--no-next', '--json')));
  assert.equal(first.queued, true);
  assert.equal(first.commit, box.commit);
  await box.helpers.waitFor(() => existsSync(box.started), 'first folder gate started', 120000); // budget: observed runner progress ceiling, not a timing assertion.
  const queued = document((await box.runLocal(box.secondFolder, 'submit', String(box.second), '--no-next', '--json')));
  assert.equal(queued.queued, true);
  const secondHead = box.git(box.secondFolder, 'rev-parse', 'HEAD');
  assert.equal(queued.commit, secondHead);
  assert.equal(gateJob({ ...box, id: box.second }).candidate, secondHead, 'the queued gate job captures the second folder, not the seat checkout');
  assert.equal(gateJob(box).candidate, box.commit, 'the first gate job still judges the first folder');
  assert.equal(existsSync(box.release), false);
  writeFileSync(box.release, 'release\n');
  assert.equal((await settledGateJob(box, box.id)).gate.green, true);
  assert.equal((await settledGateJob(box, box.second)).gate.green, true);
  assert.deepEqual([state(box, box.id).item.item_status, state(box, box.id).item.item_commit], ['submitted', box.commit]);
  assert.deepEqual([state(box, box.second).item.item_status, state(box, box.second).item.item_commit], ['submitted', secondHead]);
});

test('foreground submit from each of two item folders submits that folder\'s item [B5,V4]', async t => {
  const box = fixture(t, { enabled: false, firstFolder: true });
  writeFileSync(box.release, 'release\n');
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  const secondHead = box.git(box.secondFolder, 'rev-parse', 'HEAD');
  const wrong = (await box.runLocal(box.secondFolder, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(JSON.parse(wrong.out).error.code, 'NOT_YOURS', 'a folder submits only its own item');
  document((await box.runLocal(box.secondFolder, 'submit', String(box.second), '--no-next', '--json')));
  document((await box.runLocal(box.source, 'submit', String(box.id), '--no-next', '--json')));
  assert.deepEqual([state(box, box.id).item.item_status, state(box, box.id).item.item_commit], ['submitted', box.commit]);
  assert.deepEqual([state(box, box.second).item.item_status, state(box, box.second).item.item_commit], ['submitted', secondHead]);
});

test('a queued red retains the exact canonical refusal and the builder claim while another claim stays owned [B5,V4,H16]', async t => {
  const box = fixture(t, { result: 'red' });
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  const queued = document((await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json')));
  assert.equal(queued.queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'actual red candidate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  // B5: an item whose own gate is running frees its seat's claim slot for the next build.
  document((await box.runLocal(box.web, 'claim', String(box.second), '--json')));
  const builder = state(box, box.id).item.item_owner;
  writeFileSync(box.release, 'release\n');
  const job = await settledGateJob(box, box.id);
  assert.equal(job.id, queued.gateJob);
  assert.equal(job.gate.green, false, 'the pulled gate receipt is red');
  const completed = state(box, box.id);
  assert.deepEqual([completed.item.item_status, completed.item.item_owner], ['claimed', builder], 'a red gate keeps the builder claim');
  assert.equal(state(box, box.second).item.item_owner, builder);
  const shown = document((await box.runLocal(box.web, 'show', String(box.id), '--json')));
  const prefix = `Gate job ${job.id} red at ${box.commit.slice(0, 12)}; failing parts:\n`;
  const record = shown.thread.find(row => row.text?.startsWith(prefix));
  assert.ok(record, 'the board records the red gate result on the item thread');
  const parts = record.text.slice(prefix.length).split('\n');
  const interrupt = document((await box.runLocal(box.web, 'inbox', '--json'))).shouts.find(row => row.shout_text.startsWith(`#${box.id} gate red at ${box.commit.slice(0, 7)}: `));
  assert.ok(interrupt, 'the existing inbox channel carries the red interrupt');
  assert.ok(parts.some(part => `#${box.id} gate red at ${box.commit.slice(0, 7)}: ${part}`.slice(0, 280) === interrupt.shout_text), 'the interrupt carries the recorded refusal exactly');
  const other = join(box.dir, 'other-web');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  document((await fixtureJoin(box.runLocal, other, 'web', '--route', 'strong', '--json')));
  const foreign = (await box.runLocal(other, 'claim', String(box.id), '--json'));
  assert.equal(foreign.code, 1);
  assert.equal(JSON.parse(foreign.out).error.code, 'HELD');
  document((await box.runLocal(box.web, 'claim', String(box.id), '--json')));
  assert.equal(state(box, box.id).item.item_owner, state(box, box.second).item.item_owner, 'B5 permits the builder to reclaim alongside another item');
  document((await box.runLocal(box.web, 'release', String(box.second), '--reason', 'ROUTED_ELSEWHERE', '--no-next', '--json')));
  document((await box.runLocal(box.web, 'claim', String(box.id), '--json')));
  assert.equal(state(box, box.id).item.item_owner, builder, 'the same seat resumes at a natural break');
});
