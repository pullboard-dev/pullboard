/** A branch worktree never changes the shared board schema or triggers, and its diagnostic prints once [A5,A6,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The helper copies real candidate source into an isolated Git repository and linked worktree.
test("a branch worktree never changes the shared board's schema or triggers [A5,A6,C7]", async t => {
  const { assertBranchWorktreeBoardIsolation } = await import('../../../tests/fixtures/isolation.js');
  await assertBranchWorktreeBoardIsolation(t, fileURLToPath(new URL('../../../../..', import.meta.url)));
});


test('direct branch board opens preserve shared DDL while private databases still migrate [A5,A6,C7]', async t => {
  const { assertDirectOpenBoardIsolation } = await import('../../../tests/fixtures/regression.js');
  assertDirectOpenBoardIsolation(t, fileURLToPath(new URL('../../../../..', import.meta.url)));
});

test('clause 1: the SHARED_SCHEMA_DIFFERENCE diagnostic prints once per command, never again from the landing wake [A5,A6,C7]', async t => {
  const { assertBranchWorktreeBoardIsolation } = await import('../../../tests/fixtures/isolation.js');
  const outputs = await assertBranchWorktreeBoardIsolation(t, fileURLToPath(new URL('../../../../..', import.meta.url)));
  for (const [command, output] of Object.entries(outputs)) {
    assert.equal(output.match(/SHARED_SCHEMA_DIFFERENCE/gu)?.length ?? 0, 1,
      `${command}: SHARED_SCHEMA_DIFFERENCE appears exactly once in that command's output:\n${output}`);
  }
});
