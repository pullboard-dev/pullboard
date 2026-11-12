/** Submit refuses a head whose new commits belong to another item, naming that item [V1]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { refuseWrongBranch } from '../../src/io/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

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

/** Run the real fixture CLI and retain both output streams when setup or submission fails. */
function nativeJson(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

test('native submit refuses another item trailer and records a submission for its own trailer [V1,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const wrong of [true, false]) {
    const box = helpers.project('true');
    /** Add a diagnosed fixture item whose frozen check requires the feature committed below. */
    const add = title => nativeJson(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--route', 'mid',
      '--criterion', 'The committed feature is submitted.', '--check', 'test -f web/feature.txt', '--brief',
      'Files: web/feature.txt\nChange: commit the native submit fixture payload.\nTest: native submit preserves the matching item trailer [V1,V4]').item.item_id;
    const target = add('Target item');
    const author = wrong ? add('Source item') : target;
    nativeJson(box, box.web, 'claim', String(author));
    const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add feature [G1]');
    assert.equal(committed.status, 0, committed.stderr);
    const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
    assert.match(box.git(box.web, 'show', '-s', '--format=%B', head), new RegExp(`Pullboard-Item: #${author}\\b`));
    if (wrong) {
      nativeJson(box, box.web, 'release', String(author), '--reason', 'OTHER', '--note', 'Retain source to exercise wrong-item submission.', '--no-next');
      nativeJson(box, box.web, 'claim', String(target));
      const refused = box.run(box.web, 'submit', String(target), '--no-next', '--json');
      assert.notEqual(refused.code, 0);
      const refusal = JSON.parse(refused.out);
      assert.equal(refusal.error.code, 'WRONG_BRANCH');
      assert.match(refusal.error.message, new RegExp(`#${author}\\b`));
      assert.equal(nativeJson(box, box.web, 'show', String(target)).item_status, 'claimed');
    } else {
      nativeJson(box, box.web, 'submit', String(target), '--no-next');
      const shown = nativeJson(box, box.web, 'show', String(target));
      assert.equal(shown.item_status, 'submitted');
      assert.equal(shown.item_commit, head);
      const submission = shown.thread.findLast(row => row.kind === 'submit');
      assert.equal(submission.detail.commit, head);
      assert.equal(shown.item_id, target);
    }
  }
});
