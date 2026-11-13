/** Main moves only with a landing receipt: the trunk remote's guard refuses a push to main without a land job's permit [B3,P7]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { installTrunkGuard } from '../../../../../packages/git/index.js';
import { landingPermit } from '../../../../../packages/git/index.js';
import { permitPushOptions } from '../../../../../packages/git/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { closeCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const TRUNK = 'refs/heads/main';
// The coordinator's merge keeps the repository's own hooks on.
const HOOKED = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com'];

/** A bare trunk remote with the trunk guard installed, a developer clone pushing to it, and private runner folders. */
function guardedTrunk(t) {
  const { root } = privateFixtureFiles('pullboard-trunk-guard-');
  const dev = fixtureCommittedGraph('pullboard-trunk-guard-dev-').root;
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(dev, { recursive: true, force: true }); });
  const commit = (file, message) => {
    writeFileSync(join(dev, file), `${file}\n`);
    git(dev, ['add', file]);
    git(dev, [...AS, 'commit', '-q', '-m', message]);
    return git(dev, ['rev-parse', 'HEAD']);
  };
  const seed = commit('README.md', 'chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  const key = randomBytes(32).toString('hex');
  installTrunkGuard(remote, { key });
  const tip = () => git(root, ['--git-dir', remote, 'rev-parse', TRUNK]);
  const push = (refspec, options = []) => tryGit(dev, ['push', ...options.flatMap(option => ['-o', option]), 'origin', refspec]);
  return { root, dev, remote, key, seed, commit, tip, push };
}

test('clause 1: a push to main without a valid landing receipt is refused by the trunk remote [B3,P7]', t => {
  const box = guardedTrunk(t);
  const hand = box.commit('hand.txt', 'fix(core): a hand push [P7]');
  const bare = box.push(`${hand}:${TRUNK}`);
  assert.notEqual(bare.status, 0, 'a receipt-less push to main is refused');
  assert.match(bare.stderr, /\[TRUNK_RECEIPT\] a push to refs\/heads\/main must carry a landing job's receipt and lease/u);
  const live = Date.now() + 60_000;
  const forged = permitPushOptions({ job: 'land:1:x', runner: 'r1', leaseUntil: live, mac: landingPermit('not-the-board-key', { job: 'land:1:x', runner: 'r1', leaseUntil: live, trunk: TRUNK }) });
  const wrong = box.push(`${hand}:${TRUNK}`, forged);
  assert.match(wrong.stderr, /\[TRUNK_RECEIPT\] the landing receipt for job land:1:x is not valid/u, 'a receipt signed with another key is refused');
  const lapsed = Date.now() - 1000;
  const old = box.push(`${hand}:${TRUNK}`, permitPushOptions({ job: 'land:1:x', runner: 'r1', leaseUntil: lapsed, mac: landingPermit(box.key, { job: 'land:1:x', runner: 'r1', leaseUntil: lapsed, trunk: TRUNK }) }));
  assert.match(old.stderr, /\[TRUNK_LEASE\] job land:1:x's lease lapsed/u, 'a receipt whose lease lapsed is refused');
  assert.equal(box.tip(), box.seed, 'main never moved');
  assert.equal(box.push(`${hand}:refs/pullboard/land/1`).status, 0, 'publishing an item ref for a land job still works');
});

test('clause 2: a landing job\'s push with its receipt and lease is accepted by the trunk remote [B3,P7]', async t => {
  const box = guardedTrunk(t);
  git(box.dev, ['checkout', '-q', '-b', 'item-1']);
  const one = { id: 1, commit: box.commit('item-1.txt', 'feat(core): item 1 [P7]'), ref: 'refs/pullboard/land/1' };
  assert.equal(box.push(`${one.commit}:${one.ref}`).status, 0);
  const file = join(box.root, 'board.sqlite');
  const onBoard = work => { const board = openCellBoard(file); try { return work(board); } finally { closeCellBoard(board); } };
  const offered = onBoard(board => offerLandingJob(board.db, { items: [one], expect: box.seed, config: { trunk: { remote: box.remote } }, mode: 'pull' }));
  const calls = [];
  const call = body => onBoard(board => { const answer = boardJobQueueCall(board, body, { mode: 'pull', landingKey: () => box.key }); calls.push([body.action, answer]); return answer; });
  const taken = await takeLandingJob({ call, runner: 'runner-1', workdir: join(box.root, 'runner') });
  assert.deepEqual([taken.job, taken.receipt.outcome, taken.receipt.landed], [offered.id, 'landed', [1]], taken.receipt.detail ?? '');
  assert.equal(box.tip(), taken.receipt.trunk, 'the guarded trunk took the landing push');
  assert.ok(calls.find(([action]) => action === 'claim')[1].claim.permit.mac, 'the claim carries the board\'s permit for its lease');
  assert.ok(calls.filter(([action]) => action === 'renew').every(([, answer]) => answer.permit?.leaseUntil === answer.leaseUntil), 'each renewal carries the permit for its new lease');
});

test('the guard is on pushes only: a local merge in a guarded checkout still moves main, as the coordinator\'s merge does [B3]', t => {
  const box = guardedTrunk(t);
  const host = join(box.root, 'host');
  git(box.root, ['clone', '-q', box.remote, host]);
  installTrunkGuard(join(host, '.git'), { key: box.key });
  git(host, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(host, 'side.txt'), 'side\n');
  git(host, ['add', 'side.txt']);
  git(host, [...HOOKED, 'commit', '-q', '-m', 'feat(core): side [P7]']);
  git(host, ['checkout', '-q', 'main']);
  git(host, [...HOOKED, 'merge', '--no-ff', '-q', '-m', 'Merge #2 onto main [P7]', 'side']);
  assert.notEqual(git(host, ['rev-parse', 'main']), box.seed, 'a local merge moves main without a push');
});
