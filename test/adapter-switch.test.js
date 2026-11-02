/** Git adapter run/test selection and real audit policy [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentGitAdapter, realGitAdapter, withGitSelection, withGitMode } from '../src/git-adapter.js';
import { createMemoryGitAdapter } from '../packages/git/index.js';
import { auditAdapterEnvironment } from '../packages/kernel/index.js';

const fake = () => createMemoryGitAdapter([{ root: '/virtual/switch', branch: 'main', head: 'a'.repeat(40), commits: [{ oid: 'a'.repeat(40), tree: 'b'.repeat(40), files: {} }] }]);

test('run selection and per-test overrides stay isolated [C7]', async () => {
  const memory = fake();
  await Promise.all([
    withGitSelection({ fake: memory, env: {} }, async () => {
      assert.equal(currentGitAdapter(), memory);
      await Promise.resolve();
      await withGitMode('real', async () => { assert.equal(currentGitAdapter(), realGitAdapter); await Promise.resolve(); });
      assert.equal(currentGitAdapter(), memory);
    }),
    withGitSelection({ fake: memory, env: { PULLBOARD_TEST_REAL: 'git' } }, async () => {
      assert.equal(currentGitAdapter(), realGitAdapter);
      await withGitMode('fake', async () => { await Promise.resolve(); assert.equal(currentGitAdapter(), memory); });
      assert.equal(currentGitAdapter(), realGitAdapter);
    }),
  ]);
  assert.equal(currentGitAdapter(), realGitAdapter);
});

test('scheduled audit forces real Git even under a fake per-test request [C7]', () => {
  const env = auditAdapterEnvironment(true);
  assert.equal(env.PULLBOARD_TEST_REAL, 'all');
  assert.equal(env.PULLBOARD_ADAPTER_AUDIT, '1');
  withGitSelection({ fake: fake(), env }, () => withGitMode('fake', () => assert.equal(currentGitAdapter(), realGitAdapter)));
  assert.deepEqual(auditAdapterEnvironment(false), {});
});

test('a seeded divergence first fails the shared Git contract [C7]', () => {
  const memory = fake();
  /** The same caller-visible contract applies to both correct and deliberately broken fake. */
  const contract = adapter => assert.equal(adapter.spawnSync(['rev-parse', 'HEAD'], { cwd: '/virtual/switch', encoding: 'utf8' }).stdout, `${'a'.repeat(40)}\n`);
  const broken = { ...memory, spawnSync: (...args) => ({ ...memory.spawnSync(...args), stdout: 'wrong\n' }) };
  assert.throws(() => contract(broken), assert.AssertionError, 'the contract records the seeded drift before a fake correction');
  assert.doesNotThrow(() => contract(memory));
});
