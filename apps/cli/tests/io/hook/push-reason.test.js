/** The pre-push hook says why it kept the one-command gate instead of shard jobs, one distinct line per case [C7,#9368]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { pushShardGate } from '../../../src/io/hook/push.js';
import { pushShardSkipReason } from '../../../src/io/hook/push.js';

const ready = { pull: true, clean: true, untracked: 0, files: 5, nameable: true };

test('cli.io-hook-push-reason.pushshardskipreason-gives-a-distinct-one-line-reason: clause 1: pushShardSkipReason gives a distinct one-line reason for each case with no plan, and null when a plan exists [C7,#9368]', () => {
  assert.equal(pushShardSkipReason(ready), null);
  const reasons = [
    pushShardSkipReason({ ...ready, pull: false }),
    pushShardSkipReason({ ...ready, clean: false }),
    pushShardSkipReason({ ...ready, untracked: 2 }),
    pushShardSkipReason({ ...ready, files: 1 }),
    pushShardSkipReason({ ...ready, nameable: false }),
  ];
  for (const reason of reasons) assert.match(reason, /^[^\n]+$/u, 'one line');
  assert.equal(new Set(reasons).size, 5, 'five distinct reasons');
  assert.match(reasons[0], /runnerDispatch/u);
  assert.match(reasons[1], /uncommitted/u);
  assert.match(reasons[2], /untracked/u);
  assert.match(reasons[3], /at least two/u);
  assert.match(reasons[4], /cannot name/u);
});

test('cli.io-hook-push-reason.the-say-line-carries-the-reason-when: clause 2: the say line carries the reason when the hook falls back to the one-command gate [C7,#9368]', async t => {
  const { root } = cellRepo(t, { real: true });
  writeFileSync(join(root, 'loose.txt'), 'x');
  const said = [];
  const result = await pushShardGate({ info: { root }, config: { gate: 'node --test' } }, { say: line => said.push(line) });
  assert.equal(result, null, 'the hook keeps the one-command gate');
  assert.equal(said.length, 1);
  assert.match(said[0], /one-command gate/u);
  assert.match(said[0], /untracked/u);
});

test('cli.io-hook-push-reason.a-pushed-plan-that-exists-says-nothing: clause 2: a pushed plan that exists says nothing extra about falling back [C7,#9368]', () => {
  assert.equal(pushShardSkipReason(ready), null, 'no reason, so pushShardGate adds no fallback line');
});
