/** A pulled submit returns before its gate and keeps the captured source and tool build [B5,V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import {
  document,
  fixture,
  gateJob,
  state,
  helpersCommit,
} from '../../../tests/fixtures/submit/handoff.js';
import { settledGateJob } from '../../../tests/fixtures/submit/settle.js';

test('clause 1: queued submit returns before its gate and remains bound when the builder commits and claims again [B5,V4,H16,E18]', async t => {
  // The builder holds two queued builds beside its second and third live claims, so the seat names a cap of four [B5].
  const box = fixture(t, { companion: true, perSeat: 4, fourth: true });
  const fourth = box.fourth;
  // The gate holds on its release file while the builder moves on, so no submit waits for the queue to settle.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  const author = join(box.dir, 'companion-author');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', author, box.commit);
  const authorId = document(await fixtureJoin(box.runLocal, author, 'api', '--json')).agent;
  mkdirSync(join(author, 'api'), { recursive: true });
  writeFileSync(join(author, 'api', 'companion.txt'), 'required\n');
  box.git(author, 'add', 'api/companion.txt');
  const patch = join(box.dir, 'companion.diff');
  writeFileSync(patch, box.git(author, 'diff', '--cached', '--binary') + '\n');
  document(await box.runLocal(box.repo, 'patch', 'attach', String(box.id), patch, '--key', 'required-companion', '--author', authorId, '--source', box.commit, '--json'));
  const queued = document(await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'));
  assert.equal(queued.queued, true);
  assert.equal(queued.commit, box.commit);
  assert.match(queued.composed, /^[a-f0-9]{40}$/u, 'the gate judges the companions composed onto the builder head');
  assert.notEqual(queued.composed, box.commit);
  assert.equal(existsSync(box.release), false, 'submit acknowledged while the gate was still blocked');
  await box.helpers.waitFor(() => existsSync(box.started), 'actual captured gate execution', 120000); // budget: hang ceiling for observed real child/gate progress; no elapsed-time assertion.
  assert.equal(state(box, box.id).item.item_status, 'claimed', 'unproved work is never reviewable');
  assert.equal(gateJob(box).candidate, queued.composed, 'the queued gate job captured the composed source');
  box.git(box.web, 'checkout', '-q', '--detach', 'main');
  assert.equal(helpersCommit(box, 'web/later.txt', 'later\n').status, 0);
  assert.equal(existsSync(join(box.web, 'web/snapshot.txt')), false, 'the next build no longer contains the queued candidate');
  document(await box.runLocal(box.web, 'claim', String(box.second), '--json'));
  assert.equal(helpersCommit(box, 'web/second.txt', 'second\n').status, 0, 'real commit hooks select only the ordinary second claim');
  const secondQueued = document(await box.runLocal(box.web, 'submit', String(box.second), '--no-next', '--json'));
  assert.equal(secondQueued.queued, true, 'the second committed item also submits while the first gate is blocked');
  document(await box.runLocal(box.web, 'claim', String(box.third), '--json'));
  document(await box.runLocal(box.web, 'claim', String(fourth), '--json'));
  assert.equal(state(box, fourth).item.item_owner, state(box, box.third).item.item_owner, 'B5 permits several live claims in their own folders');
  assert.equal(gateJob(box).candidate, queued.composed, 'later commits and claims leave the queued gate on its captured source');
  writeFileSync(box.release, 'release\n');
  const job = await settledGateJob(box, box.id);
  assert.equal(job.gate.green, true);
  assert.equal((await settledGateJob(box, box.second)).gate.green, true, 'the second pulled submit completes independently');
  const completed = state(box, box.id);
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit);
  assert.equal(state(box, box.second).item.item_built_by, completed.item.item_built_by);
  assert.deepEqual(readFileSync(box.started, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: queued.composed }], 'the companion composition was actually executed');
  assert.deepEqual(readFileSync(box.finished, 'utf8').trim().split('\n').map(JSON.parse), [{ value: 'green', head: queued.composed }], 'the gate still read the captured source after the builder moved');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  // The captured item is filed on the strong route, so its reviewer joins on that route (a mid seat is refused ROUTE).
  document(await fixtureJoin(box.runLocal, reviewer, 'api', '--route', 'strong', '--json'));
  assert.equal(document(await box.runLocal(reviewer, 'next', '--verify', String(box.id), '--json')).item.item_id, box.id);
});

test('clause 1: a seat holding a claim gets submit --wait back at once with no agent marker, the result through next [P7]', async t => {
  const box = fixture(t);
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  for (const name of AGENT_SHELL_MARKERS) delete box.env[name];
  const ran = await box.inProcess(box.web, 'submit', String(box.id), '--wait', '--no-next', '--json');
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
  const reply = JSON.parse(ran.out);
  assert.equal(reply.queued, true, 'submit queued the gate and returned');
  assert.equal(reply.commit, box.commit, 'the queued gate is bound to the submitted commit');
  assert.equal(existsSync(box.release), false, 'submit --wait returned while the gate was still held');
  assert.ok(['offered', 'claimed'].includes(gateJob(box)?.step), 'the gate had not finished when submit returned');
  writeFileSync(box.release, 'release\n');
  assert.equal((await settledGateJob(box, box.id)).gate.green, true, 'the held gate then finishes on its own');
});
