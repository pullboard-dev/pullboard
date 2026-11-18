/** With push.refuseUnsharded on, a push that cannot be sharded is refused with the reason instead of running the one-command gate [C7,#9369]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { pushShardGate } from '../../../src/io/hook/push.js';

test('cli.io-hook-push-refuse-unsharded.with-push-refuseunsharded-on-and-a-dirty: clause 1: with push.refuseUnsharded on and a dirty checkout, the push gate throws PUSH_UNSHARDED with the reason and a next step [C7,#9369]', async t => {
  const { root } = cellRepo(t, { real: true });
  writeFileSync(join(root, 'loose.txt'), 'x');
  await assert.rejects(
    pushShardGate({ info: { root }, config: { gate: 'node --test' } }, { refuse: true, say: () => assert.fail('a refusal says nothing else') }),
    error => {
      assert.equal(error.code, 'PUSH_UNSHARDED');
      assert.match(error.message, /untracked/u, 'the reason from pushShardSkipReason');
      assert.match(error.message, /next: .*push again/u, 'the next step');
      return true;
    },
  );
});

test('cli.io-hook-push-refuse-unsharded.with-the-setting-off-the-hook-still: clause 2: with the setting off the hook still falls back to the one-command gate and says why [C7,#9369]', async t => {
  const { root } = cellRepo(t, { real: true });
  writeFileSync(join(root, 'loose.txt'), 'x');
  const said = [];
  const result = await pushShardGate({ info: { root }, config: { gate: 'node --test' } }, { refuse: false, say: line => said.push(line) });
  assert.equal(result, null);
  assert.match(said.join('\n'), /one-command gate/u);
});

test('cli.io-hook-push-refuse-unsharded.with-the-setting-on-but-a-plan: clause 2: with the setting on but a plan available the push shards as before [C7,#9369]', async () => {
  const plan = { source: 'a'.repeat(40), main: 'b'.repeat(40), limitMs: 1, shards: [{ files: ['x.test.js'], command: 'c' }] };
  const result = await pushShardGate({ info: { root: '/nonexistent' }, config: {} }, {
    refuse: true,
    plan: async () => plan,
    offer: async () => ({ jobs: ['job-1'], ref: 'refs/pullboard/push/t', reoffer: () => 'x' }),
    settle: async (_ctx, jobs) => ({ refused: `settled ${jobs.join(',')}` }),
    say: () => {},
  });
  assert.equal(result.isGreen, false);
  assert.deepEqual(result.jobs, ['job-1'], 'the shard jobs were offered');
  assert.match(result.problem, /settled job-1/u);
});
