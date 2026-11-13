/** A green submission records its background comparison [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { fixture } from '../../../tests/fixtures/verify/compare.js';

test('a green submission records its background comparison without a reviewer command [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:true,fixed:true,known:true,skip:true};\n');
  const head = box.helpers.attackCommit(box, box.web);
  const result = await runCliInProcess(['submit', String(box.id), '--no-next', '--json'], { cwd: box.web, env: box.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  let comparison, thread;
  // budget: bounded wait for real private runner completion; never an elapsed-time assertion.
  await box.helpers.waitFor(async () => { // budget: hang ceiling for actual background runner completion.
    const shown = await box.runLocal(box.repo, 'show', String(box.id), '--json');
    assert.equal(shown.code, 0, shown.err);
    const item = JSON.parse(shown.out);
    if (item.item_status === 'claimed') return false; // A pull submit returns at once; the item moves when its gate job finishes [P7].
    assert.equal(item.item_status, 'submitted');
    comparison = item.comparison; thread = item.thread;
    if (comparison?.status === 'unavailable') assert.fail(JSON.stringify(comparison));
    return comparison?.status === 'complete';
  }, 'automatic comparison result', 120000); // budget: real private SSH workers, parallel immutable sources, no elapsed-time assertion.
  assert.ok(thread.some(entry => entry.type === 'fact' && entry.text.includes('\"status\":\"pending\"')), 'submit records pending before its detached comparison');
  assert.equal(comparison.source, head);
  assert.deepEqual(comparison.newRed, []);
  assert.ok(comparison.head.id && comparison.base.id);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  const joined = fixtureJoin(box.run, reviewer, 'api', '--model', 'Comparison reviewer', '--json');
  assert.equal(joined.code, 0, joined.err);
  const offered = await box.runLocal(reviewer, 'next', '--verify', '--json');
  assert.equal(offered.code, 0, offered.err);
  assert.equal(JSON.parse(offered.out).comparison.status, 'complete');
});
