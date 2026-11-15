/** An accept whose reviewed trunk left main is judged from the merge base, and each failure names its own cause [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verdictProjector } from '../../../src/io/verdict/freshness.js';

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

/**
 * Build main (base, then `mainFile` changed) and a reviewed trunk off main (base, then a trunk-only commit) with the
 * checked commit on top of it touching y.txt; return the projector's state for that accepted item.
 */
function freshness(mainFile, { review = {}, trunkOnMain = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trunk-off-main-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const file of ['x.txt', 'y.txt', 'z.txt']) writeFileSync(join(dir, file), `${file}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'reviewed');
  const trunk = commit(dir, 'z.txt', 'trunk only\n');
  const checked = commit(dir, 'y.txt', 'item change\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, mainFile, 'main change\n');
  const item = { item_id: 7, item_status: 'verified', item_commit: checked, item_claim_head: base };
  const accepted = { review: { trunk: trunkOnMain ? base : trunk, head: checked, paths: ['y.txt'], ...review } };
  const projector = verdictProjector(dir, {}, { main: git(dir, 'rev-parse', 'main') }, {
    events: () => [], acceptedVerdict: () => accepted, verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
  return { state: projector.state(item), trunk, base };
}

test('verify.freshness.trunk-merge-base: clause 1: an accept whose reviewed trunk is not an ancestor of main is judged from merge-base(trunk, main) with the same overlap rule [C7]', () => {
  const unrelated = freshness('x.txt');
  assert.equal(unrelated.state, null, 'main touching a file the review never read leaves the accept fresh');
  const overlapping = freshness('y.txt');
  assert.equal(overlapping.state.code, 'STALE_VERDICT');
  assert.equal(overlapping.state.file, 'y.txt', 'main touching a reviewed path is named as the stale file');
  assert.equal(overlapping.state.reason, undefined, 'a judged overlap carries no history-unavailable reason');
});

test('verify.freshness.reasons: clause 2: each failure cause of the freshness check has its own reason text [C7]', () => {
  const noHistory = freshness('x.txt', { review: { trunk: 'a'.repeat(40) } }).state.reason;
  assert.match(noHistory, /reviewed trunk aaaaaaaaaaaa is missing from this replica/u);
  const noChecked = freshness('x.txt', { review: { head: 'b'.repeat(40) } }).state.reason;
  assert.match(noChecked, /checked commit bbbbbbbbbbbb is missing from this replica/u);
  const sealed = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'trunk-off-main-'));
    git(dir, 'init', '-q', '-b', 'main');
    const first = commit(dir, 'y.txt', '1\n');
    const second = commit(dir, 'y.txt', '2\n');
    const projector = verdictProjector(dir, {}, { main: first }, { events: () => [], acceptedVerdict: () => ({ review: { trunk: first, head: second, paths: ['y.txt'] } }),
      verdictReviewProblem: () => 'bad', trunkRef: () => 'refs/heads/main' });
    return projector.state({ item_id: 8, item_status: 'verified', item_commit: second, item_claim_head: first }).reason;
  })();
  assert.match(sealed, /sealed review does not match/u);
  assert.equal(new Set([noHistory, noChecked, sealed]).size, 3, 'the three reasons are distinct');
});
