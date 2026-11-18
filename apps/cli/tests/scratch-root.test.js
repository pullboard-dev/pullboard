/** With scratch set, sandbox and check-baseline folders are created under it, and worktrees stay where the worktrees setting puts them [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBaseline } from '../../../packages/gate/index.js';
import { captureTestRuntimes } from '../../../packages/sandbox/index.js';
import { privateFixtureFiles } from '../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../packages/gate/tests/fixtures/child.js';
import { policyRepository } from '../../../packages/store/tests/fixtures/submit.js';
import { worktreeLocation } from '../src/io/worktree.js';

/** Runs the body with PULLBOARD_SCRATCH naming a fresh folder, restoring the environment and removing both folders after. */
function withScratch(body) {
  const scratch = privateFixtureFiles('pullboard-scratch-test-').root;
  const previous = process.env.PULLBOARD_SCRATCH;
  process.env.PULLBOARD_SCRATCH = scratch;
  try { return body(scratch); } finally {
    if (previous === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('cli.scratch-root.with-scratch-set-the-sandbox-capture-folder: clause 1: with scratch set, the sandbox capture folder is created under it [C7]', () => withScratch(scratch => {
  const capture = captureTestRuntimes({});
  const directory = capture.env.PULLBOARD_RUNTIME_CAPTURE_DIR;
  try { assert.equal(realpathSync(directory).startsWith(scratch), true, `${directory} is not under ${scratch}`); } finally { capture.finish(); rmSync(directory, { recursive: true, force: true }); }
}));

test('cli.scratch-root.with-scratch-set-the-check-baseline-tree: clause 1: with scratch set, the check-baseline tree is created under it [C7]', () => withScratch(scratch => {
  const repo = policyRepository(privateFixtureFiles('pullboard-scratch-repo-').root);
  try {
    const seen = join(scratch, 'where.txt');
    const result = checkBaseline(repo, `pwd > ${seen}`, { main: runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }) });
    assert.notEqual(result.result, 'unavailable', result.reason);
    assert.equal(readFileSync(seen, 'utf8').trim().startsWith(scratch), true, 'the check ran outside the scratch root');
  } finally { rmSync(repo, { recursive: true, force: true }); }
}));

test('cli.scratch-root.with-scratch-set-worktrees-stay-where-the: clause 2: with scratch set, worktrees stay where the worktrees setting puts them [C7]', () => withScratch(scratch => {
  assert.equal(worktreeLocation('/repo/main', { worktrees: 'inside' }), '/repo/main/.claude/worktrees/<lane>-N');
  assert.equal(worktreeLocation('/repo/main', { worktrees: 'beside' }), '/repo/main-<lane>-N');
  assert.equal(worktreeLocation('/repo/main', {}).startsWith(scratch), false);
}));
