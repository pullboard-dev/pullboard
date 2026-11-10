/** A verified item whose reviewed trunk is an ancestor of main is fresh, never STALE_VERDICT [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../../../apps/cli/tests/fixtures/board/submit.js';
import { verdictProjector } from '../../../../src/io/verdict/freshness.js';

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Commit one file change on the current branch and return the new commit. */
function commit(dir, file, text) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `change ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Build a real repo whose reviewed trunk is on main, main moves on an unrelated file, and return the projected state. */
function ancestorState(t, mainFile) {
  const dir = temporaryRepository(t, 'verdict-ancestor-');
  for (const file of ['x.txt', 'y.txt']) writeFileSync(join(dir, file), `${file}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const trunk = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'reviewed');
  const checked = commit(dir, 'y.txt', 'item change\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, mainFile, 'main change\n');
  const item = { item_id: 7, item_status: 'verified', item_commit: checked, item_claim_head: trunk };
  const projector = verdictProjector(dir, {}, { main: git(dir, 'rev-parse', 'main') }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk, head: checked, paths: ['y.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
  return projector.state(item);
}

test('clause 2: a verified item whose reviewed trunk is an ancestor of main is fresh, not STALE_VERDICT [C7]', t => {
  assert.equal(ancestorState(t, 'x.txt'), null, 'main moving on an unreviewed file leaves the accept fresh');
  const overlap = ancestorState(t, 'y.txt');
  assert.equal(overlap.code, 'STALE_VERDICT');
  assert.equal(overlap.file, 'y.txt', 'a real overlap names the file, not an unavailable history');
  assert.equal(overlap.reason, undefined);
});

test('clause 1: the ancestor check runs through the Git adapter, so a trunk on main raises no ReferenceError [C7]', t => {
  const state = ancestorState(t, 'x.txt');
  assert.equal(state, null, 'an undefined spawnSync would surface as a history-unavailable stale state');
});
