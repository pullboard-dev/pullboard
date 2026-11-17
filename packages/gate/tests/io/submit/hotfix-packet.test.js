/** @pullboard-test-input source-cell packages/verify */
/** The review packet of a hotfix submit already in main's history is the commit's own patch, never empty [C7,#9446,#3127]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { buildReviewPacket } from '../../../../verify/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** A repository with a hotfix on main and a later commit after it; `merge` makes the hotfix a merge commit. */
function history(t, { merge }) {
  const tree = privateFixtureFiles('pb-hotfix-packet-');
  const root = tree.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: root }).trim();
  const save = (file, text, message) => { tree.write(file, text); run('add', '-A'); run('commit', '-q', '-m', message); return run('rev-parse', 'HEAD'); };
  run('init', '-q');
  save('base.txt', 'base\n', 'base');
  let hotfix;
  if (merge) {
    run('checkout', '-q', '-b', 'side');
    save('hotfix.txt', 'fixed\n', 'fix');
    run('checkout', '-q', 'main');
    run('merge', '-q', '--no-ff', '-m', 'hotfix merge', 'side');
    hotfix = run('rev-parse', 'HEAD');
  } else hotfix = save('hotfix.txt', 'fixed\n', 'hotfix');
  const parent = run('rev-parse', `${hotfix}^`);
  const main = save('later.txt', 'later\n', 'later');
  return { root, hotfix, parent, main };
}

/** The board records a packet reads for a hotfix submit whose gate went green against `main`. */
function inputs(repo) {
  const criterion = '1. the hotfix holds [reasoning]';
  return {
    item: { item_id: 9, item_commit: repo.hotfix, item_criterion: criterion, item_frozen: JSON.stringify({ criterion, check: '', rows: [] }), item_brief: '', item_check: null },
    submit: { commit: repo.hotfix, gateGreen: true, policyCommit: repo.main },
    receipts: [], baseline: null, mainRuns: [], thread: [],
  };
}

test('clause 1: for a head that is an ancestor of main, the review packet diffs head against its own parent and is not empty [C7,#9446]', t => {
  const repo = history(t, { merge: false });
  const packet = buildReviewPacket(repo.root, inputs(repo));
  assert.equal(packet.base, repo.parent, 'the base is the head\'s parent, not the head itself');
  assert.deepEqual(packet.diff.files, ['hotfix.txt']);
  assert.match(packet.diff.patch, /\+fixed/u);
});

test('clause 2: a hotfix merge citing the item builds a non-empty packet, so it submits for review with no EMPTY_SUBMIT [C7,#9446]', t => {
  const repo = history(t, { merge: true });
  const packet = buildReviewPacket(repo.root, inputs(repo));
  assert.equal(packet.base, repo.parent, 'a merge is read against its first parent');
  assert.ok(packet.diff.patch.length > 0, 'the patch is the merged change');
  assert.deepEqual(packet.diff.files, ['hotfix.txt']);
});
