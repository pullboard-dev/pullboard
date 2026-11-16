/** A read of 1,038 verified items asks Git about ancestry in a bounded number of processes, not one per item [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';
import {
  realGitAdapter,
  withGitContractAdapter,
} from '../../../../../git/light.js';
import { verdictProjector } from '../../../../src/io/verdict/freshness.js';

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('verify.freshness.batched-git: clause 1: ancestryStatus spawns at most 3 git processes for 1,038 verified items, with the same answers as before [C7]', t => {
  const dir = temporaryRepository(t, 'verdict-batched-');
  writeFileSync(join(dir, 'x.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const landed = [];
  for (let step = 0; step < 6; step += 1) {
    writeFileSync(join(dir, 'x.txt'), `step ${step}\n`);
    git(dir, 'commit', '-q', '-am', `step ${step}`);
    landed.push(git(dir, 'rev-parse', 'HEAD'));
  }
  git(dir, 'checkout', '-q', '-b', 'side', landed[0]);
  writeFileSync(join(dir, 'y.txt'), 'side\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'side');
  const unlanded = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  const trunk = git(dir, 'rev-parse', 'main');
  const missing = 'f'.repeat(40);
  const commits = [landed[2], unlanded, missing];
  // 1,038 verified items over three kinds of commit: on main, off main, and absent from this replica.
  const items = Array.from({ length: 1_038 }, (_, index) => ({ item_id: index + 1, item_status: 'verified',
    item_commit: commits[index % 3], item_claim_head: landed[0] }));
  const ancestry = [];
  const counting = { ...realGitAdapter, spawnSync(args, options) { if (args.some(arg => ['rev-list', 'cat-file', 'merge-base'].includes(arg)) && !args.includes('--is-ancestor') || args.includes('--is-ancestor')) ancestry.push(args.join(' ')); return realGitAdapter.spawnSync(args, options); } };
  const reasons = withGitContractAdapter(counting, () => {
    const projector = verdictProjector(dir, {}, { main: trunk }, {
      events: () => [], acceptedVerdict: item => ({ review: { trunk: landed[0], head: item.item_commit, paths: ['x.txt'] } }),
      verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
    projector.prime(items);
    return items.slice(0, 3).map(item => projector.state(item)).concat(items.map(item => projector.state(item)).slice(3));
  });
  assert.equal(reasons[0], null, 'a commit on main is fresh');
  assert.equal(reasons[1]?.code, 'STALE_VERDICT', 'a commit off main is judged by its overlap, not treated as landed');
  assert.match(reasons[2]?.reason ?? '', /missing from this replica/u, 'an absent commit still names the missing object');
  assert.ok(ancestry.length <= 3, `ancestry took ${ancestry.length} Git processes: ${ancestry.join(' | ')}`);
  assert.equal(ancestry.filter(args => args.includes('--is-ancestor')).length, 0, 'no per-item merge-base process remains');
});
