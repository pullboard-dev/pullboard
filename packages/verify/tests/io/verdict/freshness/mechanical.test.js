/** With a residualConflicts port, a merge conflict the mechanical merge resolves keeps the accept fresh [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';
import { verdictProjector } from '../../../../src/io/verdict/freshness.js';

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Commit a ten-line a.txt with line 2 replaced by `text` on the current branch and return the commit. */
function commitLine(dir, text) {
  const lines = Array.from({ length: 10 }, (_, index) => `a line ${index}`);
  if (text) lines[2] = text;
  writeFileSync(join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', `a ${text ?? 'base'}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A repository whose reviewed a.txt line two conflicts with main's edit of the same line, plus the projector's state for the accepted item. */
function conflicted(t) {
  const dir = temporaryRepository(t, 'verdict-mechanical-');
  const base = commitLine(dir, null);
  git(dir, 'checkout', '-q', '-b', 'item');
  const head = commitLine(dir, 'item line two');
  git(dir, 'checkout', '-q', 'main');
  const tip = commitLine(dir, 'main line two');
  git(dir, 'checkout', '-q', '--detach', head);
  const stateWith = residualConflicts => verdictProjector(dir, {}, { main: tip }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk: base, head, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main', ...(residualConflicts ? { residualConflicts } : {}) })
    .state({ item_id: 7, item_status: 'verified', item_commit: head, item_claim_head: base });
  return { stateWith, tip };
}

test('verify.freshness.mechanical-port: clause 1: a conflict the port reports resolved keeps the accept fresh, and a port returning files or no port leaves STALE_VERDICT naming the file [C7]', t => {
  const r = conflicted(t);
  const seen = [];
  assert.equal(r.stateWith((root, tip, checked) => { seen.push([tip, checked]); return []; }), null, 'a port returning no files keeps the verdict');
  assert.equal(seen.length, 1, 'the projector passed the port through to composesUnchanged');
  assert.equal(seen[0][0], r.tip, 'the port is asked about current main');
  const stale = r.stateWith(() => ['a.txt']);
  assert.equal(stale?.code, 'STALE_VERDICT', 'a port returning the file is stale');
  assert.equal(stale.file, 'a.txt', 'the stale state names the file');
  assert.equal(r.stateWith()?.code, 'STALE_VERDICT', 'with no port the conflict is stale as today');
});
