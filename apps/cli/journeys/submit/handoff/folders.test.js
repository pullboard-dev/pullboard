/** Queued submissions from two item folders stay bound to their own claims and sources [B5,V4,H16,E18]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
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
  state,
  waitJob,
} from '../../../tests/fixtures/submit/handoff.js';

test('two item folders stamp and queue their own claims while the first gate runs [B5,V4]', async t => {
  const box = fixture(t, { firstFolder: true });
  assert.match(box.git(box.source, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  assert.match(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.second}\\b`));
  assert.doesNotMatch(box.git(box.secondFolder, 'log', '-1', '--format=%B'), new RegExp(`Pullboard-Item: #${box.id}\\b`));
  const marker = box.git(box.source, 'rev-parse', '--git-path', 'pullboard-item.json');
  rmSync(marker);
  document(box.run(box.source, 'status', '--json'));
  const restored = `${JSON.stringify({ version: 1, seat: state(box, box.id).item.item_owner, item: box.id })}\n`;
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(restored)}\0${restored}`).digest('hex');
  assert.equal(box.git(box.source, 'hash-object', marker), blob, 'pre-marker folder restores its own private identity');
  writeFileSync(marker, '{broken');
  assert.equal(box.run(box.source, 'status', '--json').code, 1, 'a damaged marker is never silently replaced');
  rmSync(marker);
  for (const command of [['status'], ['inbox'], ['show', String(box.id)]]) document(box.run(box.source, ...command, '--json'));
  const renewed = document(box.run(box.source, 'claim', String(box.id), '--json'));
  assert.equal(renewed.itemFolder, box.source, 'renewing inside the folder reopens the same folder beside the seat');
  const first = document(box.run(box.source, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(first.commit, box.commit);
  await box.helpers.waitFor(() => existsSync(box.started), 'first folder gate started', 120000); // budget: observed worker progress ceiling, not a timing assertion.
  const queued = document(box.run(box.secondFolder, 'submit', String(box.second), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  assert.equal(state(box, box.second).job.commit, box.git(box.secondFolder, 'rev-parse', 'HEAD'), 'the queued seal captures the second folder, not the seat checkout');
  assert.equal(existsSync(box.release), false);
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'green');
  await box.helpers.waitFor(() => { // budget: worker cleanup hang ceiling, not a timing assertion.
    const job = state(box, box.second).job;
    return job && job.state === 'green' && !existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source'));
  }, 'second folder worker cleanup', 120000);
  assert.equal(state(box, box.id).item.item_status, 'submitted');
  assert.equal(state(box, box.second).item.item_status, 'submitted');
});

test('foreground submit from each of two item folders submits that folder\'s item [B5,V4]', t => {
  const box = fixture(t, { enabled: false, firstFolder: true });
  writeFileSync(box.release, 'release\n');
  assert.equal(box.helpers.commitFile(box, box.secondFolder, 'web/second.txt', 'second\n', 'feat(web): second folder [G1]').status, 0);
  const secondHead = box.git(box.secondFolder, 'rev-parse', 'HEAD');
  const wrong = box.run(box.secondFolder, 'submit', String(box.id), '--no-next', '--json');
  assert.equal(JSON.parse(wrong.out).error.code, 'NOT_YOURS', 'a folder submits only its own item');
  document(box.run(box.secondFolder, 'submit', String(box.second), '--no-next', '--json'));
  document(box.run(box.source, 'submit', String(box.id), '--no-next', '--json'));
  assert.deepEqual([state(box, box.id).item.item_status, state(box, box.id).item.item_commit], ['submitted', box.commit]);
  assert.deepEqual([state(box, box.second).item.item_status, state(box, box.second).item.item_commit], ['submitted', secondHead]);
});

test('a queued red retains the exact canonical refusal and the builder claim while another claim stays owned [B5,V4,H16]', async t => {
  const box = fixture(t, { result: 'red' });
  document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json'));
  await box.helpers.waitFor(() => existsSync(box.started), 'actual red candidate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  document(box.run(box.web, 'claim', String(box.second), '--json'));
  writeFileSync(box.release, 'release\n');
  await waitJob(box, 'red');
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'claimed');
  assert.equal(completed.job.error.code, 'GATE_RED');
  const retained = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', completed.job.id, 'refusal.json'), 'utf8'));
  assert.deepEqual(completed.job.error, retained.error);
  assert.equal(state(box, box.second).item.item_owner, completed.job.agentId);
  const shown = document(box.run(box.web, 'show', String(box.id), '--json'));
  assert.deepEqual(shown.queuedSubmit.error, retained.error);
  const interrupt = document(box.run(box.web, 'inbox', '--json')).shouts.find(row => row.shout_text.includes(`Queued submit #${box.id} was refused`));
  assert.ok(interrupt, 'the existing inbox channel carries the red interrupt');
  const other = join(box.dir, 'other-web');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  document(fixtureJoin(box.run, other, 'web', '--route', 'strong', '--json'));
  const foreign = box.run(other, 'claim', String(box.id), '--json');
  assert.equal(foreign.code, 1);
  assert.equal(JSON.parse(foreign.out).error.code, 'HELD');
  document(box.run(box.web, 'claim', String(box.id), '--json'));
  assert.equal(state(box, box.id).item.item_owner, state(box, box.second).item.item_owner, 'B5 permits the builder to reclaim alongside another item');
  document(box.run(box.web, 'release', String(box.second), '--reason', 'ROUTED_ELSEWHERE', '--no-next', '--json'));
  document(box.run(box.web, 'claim', String(box.id), '--json'));
  assert.equal(state(box, box.id).item.item_owner, completed.job.agentId, 'the same seat resumes at a natural break');
});
