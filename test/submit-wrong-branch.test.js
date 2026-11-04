/** Submit refuses a head whose new commits belong to another item, naming that item [V1]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { refuseWrongBranch } from '../apps/cli/src/shell/cli/submit.js';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** Build a real repo whose main has one commit, then commit each message on a feature branch. */
function repoWith(messages) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wrong-branch-'));
  dirs.push(root);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: base');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'work');
  messages.forEach((message, index) => {
    writeFileSync(join(root, `f${index}.txt`), `${index}\n`);
    git('add', '.');
    git('commit', '-q', '-m', message);
  });
  return { root, main, head: git('rev-parse', 'HEAD') };
}

test('[V1] submitting item A from a branch whose new commits all name item B is refused naming B', () => {
  const { root, main, head } = repoWith(['feat(x): one [G1]\n\nPullboard-Item: #7', 'feat(x): two [G1]\n\nPullboard-Item: #7']);
  assert.throws(() => refuseWrongBranch(root, { item_id: 3 }, head, { commit: main }),
    (error) => error.code === 'WRONG_BRANCH' && /#7/u.test(error.message) && /#3/u.test(error.message));
});

test('[V1] a branch carrying the submitted item trailer, or no trailers, submits', () => {
  const own = repoWith(['feat(x): one [G1]\n\nPullboard-Item: #3']);
  refuseWrongBranch(own.root, { item_id: 3 }, own.head, { commit: own.main });
  const mixed = repoWith(['feat(x): one [G1]\n\nPullboard-Item: #7', 'feat(x): two [G1]\n\nPullboard-Item: #3']);
  refuseWrongBranch(mixed.root, { item_id: 3 }, mixed.head, { commit: mixed.main });
  const bare = repoWith(['feat(x): untrailed']);
  refuseWrongBranch(bare.root, { item_id: 3 }, bare.head, { commit: bare.main });
});

test('[V1] a topic merged --no-ff onto main still names its item, so the wrong submitted item is refused', () => {
  const { root, main, head } = repoWith(['feat(x): one [G1]\n\nPullboard-Item: #7']);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'candidate', main);
  git('merge', '-q', '--no-ff', '-m', 'Merge work', 'work');
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, head);
  assert.throws(() => refuseWrongBranch(root, { item_id: 3 }, merged, { commit: main }),
    (error) => error.code === 'WRONG_BRANCH' && /#7/u.test(error.message));
  refuseWrongBranch(root, { item_id: 7 }, merged, { commit: main });
});
