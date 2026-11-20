/** A tick at an earlier head counts as the submitted head when only a merge of main separates them [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runFixtureGit } from '../../fixtures/child.js';
import { fixtureCommittedGraph } from '../../fixtures/testkit.js';
import { sameWorkHeads } from '../../../src/io/verify/merge-ticks.js';

const CRITERION = 'The item meets its bar:\n1. apps/x/tests/a.test.js: it works [test]';

/** A real repository: main, an item branch with one commit, then main moves on and is merged into the branch. */
function fixture(t, { mergeTouches = null } = {}) {
  const graph = fixtureCommittedGraph('pullboard-merge-ticks-');
  const { root, put, commit } = graph;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  put('README.md', 'base\n');
  put('apps/x/src/a.js', 'export const a = 0;\n');
  put('apps/x/src/b.js', 'export const b = 0;\n');
  put('apps/x/tests/a.test.js', 'test zero\n');
  commit();
  git('switch', '-q', '-c', 'item');
  put('apps/x/src/a.js', 'export const a = 1;\n');
  const tick = commit();
  git('switch', '-q', 'main');
  put('README.md', 'main moved\n');
  if (mergeTouches) put(mergeTouches, 'changed by main\n');
  commit();
  git('switch', '-q', 'item');
  git('merge', '-q', '--no-edit', 'main');
  const head = git('rev-parse', 'HEAD');
  const item = { item_commit: head, item_files: 'apps/x/src/a.js', item_criterion: CRITERION, item_brief: '' };
  const thread = [{ type: 'fact', kind: 'note', by: 'web-1', text: `clause 1 [test]: green pullboard test run of apps/x/tests/a.test.js at ${tick}, run abc: 1 case passed` }];
  return { root, git, put, commit, tick, head, item, thread };
}

test('cli.io-verify-merge-ticks.a-merge-of-main-only-keeps-the-cited-head: clause 1: sameWorkHeads returns a cited head A when the submitted head is A plus a merge of main that left the item files and the cited test files byte-identical [C7]', t => {
  const { root, tick, item, thread } = fixture(t);
  assert.deepEqual(sameWorkHeads(root, item, thread), [tick]);
});

test('cli.io-verify-merge-ticks.a-changed-file-or-no-ancestor-gives-none: clause 2: sameWorkHeads returns [] when the merge changed an item file or a cited test file, when A is not an ancestor of the head, or when the item has no recorded files [C7]', t => {
  const itemFile = fixture(t, { mergeTouches: 'apps/x/src/b.js' });
  assert.deepEqual(sameWorkHeads(itemFile.root, { ...itemFile.item, item_files: 'apps/x/src/a.js\napps/x/src/b.js' }, itemFile.thread), [], 'the merge changed an item file');
  const testFile = fixture(t, { mergeTouches: 'apps/x/tests/a.test.js' });
  assert.deepEqual(sameWorkHeads(testFile.root, testFile.item, testFile.thread), [], 'the merge changed a cited test file');
  const { root, git, put, commit, item, thread } = fixture(t);
  assert.deepEqual(sameWorkHeads(root, { ...item, item_files: '' }, thread), [], 'no recorded files');
  git('switch', '-q', '-c', 'other', 'main~1');
  put('apps/x/src/other.js', 'x\n');
  const unrelated = commit();
  git('switch', '-q', 'item');
  const stranger = [{ type: 'fact', kind: 'note', by: 'web-1', text: `clause 1 [test]: green pullboard test run at ${unrelated}` }];
  assert.deepEqual(sameWorkHeads(root, item, stranger), [], 'a cited commit that is not an ancestor of the head');
});
