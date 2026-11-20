/** A pure git helper rebuilds a gate candidate on the trunk head, or names the files that conflict, on a real temporary repository [C7,#12165]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { rebuildOnTrunk } from '../../../src/io/gate/rebuild.js';

/** A repository whose trunk and candidate both changed `shared.txt` from one base, plus a file only each side touched. */
function diverged(t, { conflict }) {
  const repo = cellRepo(t, { real: true, config: { affectedTests: 'node --test' } });
  repo.put('shared.txt', 'base\n');
  repo.put('other.txt', 'base\n');
  const base = repo.commitAll();
  git(repo.root, ['checkout', '-q', '-b', 'candidate', base]);
  repo.put('candidate-only.txt', 'candidate\n');
  repo.put('other.txt', 'candidate\n');
  if (conflict) repo.put('shared.txt', 'candidate\n');
  const commit = repo.commitAll();
  git(repo.root, ['checkout', '-q', '-b', 'trunk', base]);
  repo.put('trunk-only.txt', 'trunk\n');
  if (conflict) { repo.put('shared.txt', 'trunk\n'); repo.put('other.txt', 'trunk\n'); }
  const trunk = repo.commitAll();
  git(repo.root, ['config', 'user.name', 'Gate Test']);
  git(repo.root, ['config', 'user.email', 'gate@example.invalid']);
  return { repo, commit, trunk };
}

test('api.io-gate-rebuild.rebuilt-on-trunk: clause 1: rebuildOnTrunk(root, { trunk, commit }) on a real temporary git repository returns { commit: <new sha> } whose tree equals git merge-tree --write-tree of trunk and commit, with trunk and commit as its parents and no ref, index or work tree change [C7]', t => {
  const { repo, commit, trunk } = diverged(t, { conflict: false });
  const before = { head: git(repo.root, ['rev-parse', 'HEAD']), branches: git(repo.root, ['branch', '--format=%(refname) %(objectname)']), status: git(repo.root, ['status', '--porcelain']) };
  const built = rebuildOnTrunk(repo.root, { trunk, commit });
  assert.deepEqual(Object.keys(built), ['commit']);
  assert.match(built.commit, /^[a-f0-9]{40}$/u);
  const expected = tryGit(repo.root, ['merge-tree', '--write-tree', trunk, commit]).stdout.split('\n')[0];
  assert.equal(git(repo.root, ['rev-parse', `${built.commit}^{tree}`]), expected);
  assert.equal(git(repo.root, ['rev-list', '--parents', '-n', '1', built.commit]), `${built.commit} ${commit} ${trunk}`);
  assert.deepEqual({ head: git(repo.root, ['rev-parse', 'HEAD']), branches: git(repo.root, ['branch', '--format=%(refname) %(objectname)']), status: git(repo.root, ['status', '--porcelain']) }, before);
});

test('api.io-gate-rebuild.conflict-names-files: clause 2: when the merge conflicts rebuildOnTrunk returns { conflicts: [paths] } naming each conflicting file sorted, and creates no commit [C7]', t => {
  const { repo, commit, trunk } = diverged(t, { conflict: true });
  const count = () => git(repo.root, ['rev-list', '--all', '--count']);
  const before = count();
  assert.deepEqual(rebuildOnTrunk(repo.root, { trunk, commit }), { conflicts: ['other.txt', 'shared.txt'] });
  assert.equal(count(), before);
});
