/** composeSliceReview: a parent review holds the parent head plus each submitted slice, merged in slice id order [C7,#2397]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { composeSliceReview } from '../../../src/io/verify/slices.js';

/** A board stub answering the one slice query with the given [id, commit] rows. */
const boardOf = rows => ({ db: { prepare: () => ({ all: () => rows.map(([id, commit]) => ({ item_id: id, item_commit: commit })) }) } });

/** A fixture repo with a parent head and one commit per slice, each branched from the parent head and writing one file. */
function fixture(t, files) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const root = box.repo;
  const git = (...args) => box.git(root, ...args).trim();
  const base = git('rev-parse', 'HEAD');
  const commits = files.map(([path, text], index) => {
    git('switch', '-q', '--detach', base);
    writeFileSync(join(root, path), text);
    git('add', '-A');
    git('commit', '-q', '-m', `slice ${index}`);
    return git('rev-parse', 'HEAD');
  });
  git('switch', '-q', '--detach', base);
  return { root, git, base, commits };
}

test('cli.io-verify-slices.composes-parent-with-slices-in-id-order: clause 1: composeSliceReview returns a review commit holding the parent head plus each submitted slice item_commit merged in slice id order [C7,#2397]', t => {
  const { root, git, base, commits } = fixture(t, [['one.txt', 'one\n'], ['two.txt', 'two\n']]);
  const composed = composeSliceReview(root, boardOf([[11, commits[0]], [12, commits[1]]]), { item_id: 10, item_commit: base });
  assert.deepEqual(composed.slices, [11, 12]);
  for (const commit of [base, ...commits]) git('merge-base', '--is-ancestor', commit, composed.commit);
  assert.equal(git('rev-parse', `${composed.commit}^2`), commits[1]);
  assert.equal(git('show', `${composed.commit}:one.txt`), 'one');
  assert.equal(git('show', `${composed.commit}:two.txt`), 'two');
  assert.equal(composeSliceReview(root, boardOf([]), { item_id: 10, item_commit: base }).commit, base);
});

test('cli.io-verify-slices.conflict-refuses-slice-compose: clause 2: a slice commit that conflicts with the composition refuses SLICE_COMPOSE naming that slice id and leaves no branch behind [C7,#2397]', t => {
  const { root, git, base, commits } = fixture(t, [['same.txt', 'first\n'], ['same.txt', 'second\n']]);
  const refs = () => git('for-each-ref');
  const before = refs();
  assert.throws(() => composeSliceReview(root, boardOf([[11, commits[0]], [12, commits[1]]]), { item_id: 10, item_commit: base }), /SLICE_COMPOSE.*#12/u);
  assert.equal(refs(), before);
});
