/** A branch worktree never changes the shared board schema or triggers [A5,A6,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The helper copies real candidate source into an isolated Git repository and linked worktree.
test("a branch worktree never changes the shared board's schema or triggers [A5,A6,C7]", async t => {
  const { assertBranchWorktreeBoardIsolation } = await import('../../../tests/fixtures/isolation.js');
  await assertBranchWorktreeBoardIsolation(t, fileURLToPath(new URL('../../../../..', import.meta.url)));
});

