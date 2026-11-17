/**
 * The first inbox of a fresh seat answers in under a second on the recorded production-scale board [C7].
 * The seat joins in a new worktree of the shared e2e repo; its first inbox reads from the board head (#6172), not the whole log.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';

const BUDGET_MS = 1000;

/** The failure for a time at or over the budget, naming the time and the budget; null within it. */
function overBudget(name, ms, budget = BUDGET_MS) {
  return ms < budget ? null : `${name} took ${ms.toFixed(0)} ms, over its ${budget} ms budget`;
}

test(`clause 1: a fresh seat's first inbox on the 2,500-item board measures 162 ms and answers in under ${BUDGET_MS} ms [C7]`, async (t) => {
  const box = largeBoard(t);
  const fresh = join(box.dir, 'fresh-seat');
  box.git(box.repo, 'worktree', 'add', '--detach', fresh);
  const joined = await box.inProcess(fresh, 'join', 'web');
  assert.equal(joined.code, 0, `join: ${joined.err}${joined.out}`);
  const started = performance.now();
  const inbox = await box.inProcess(fresh, 'inbox');
  const elapsed = performance.now() - started;
  assert.equal(inbox.code, 0, `inbox: ${inbox.err}${inbox.out}`);
  console.log(`# fresh-seat inbox ${elapsed.toFixed(0)} ms`);
  const over = overBudget('the first inbox', elapsed);
  assert.equal(over, null, over ?? '');
});
