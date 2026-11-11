/** Git adapter run/test selection and real audit policy [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mainAuditFixture } from '../../tests/fixtures/main/audit/project.js';
import { runFixtureExecFile } from '../../tests/fixtures/child.js';
import { currentGitAdapter } from '../../../../packages/git/index.js';
import { realGitAdapter } from '../../../../packages/git/index.js';
import { withGitAdapter } from '../../../../packages/git/index.js';
import { withGitContractAdapter } from '../../../../packages/git/index.js';
import { withGitSelection } from '../../../../packages/git/index.js';
import { withGitMode } from '../../../../packages/git/index.js';
import { createMemoryGitAdapter } from '../../../../packages/git/index.js';
import { auditAdapterEnvironment } from '../../../../packages/kernel/index.js';

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
  const memory = fake();
  withGitSelection({ fake: memory, env }, () => {
    withGitMode('fake', () => assert.equal(currentGitAdapter(), realGitAdapter));
    withGitAdapter(memory, () => assert.equal(currentGitAdapter(), realGitAdapter));
  });
  const previous = process.env.PULLBOARD_ADAPTER_AUDIT;
  process.env.PULLBOARD_ADAPTER_AUDIT = '1';
  try {
    withGitAdapter(memory, () => assert.equal(currentGitAdapter(), realGitAdapter));
    withGitContractAdapter(memory, () => assert.equal(currentGitAdapter(), memory));
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_ADAPTER_AUDIT;
    else process.env.PULLBOARD_ADAPTER_AUDIT = previous;
  }
  assert.deepEqual(auditAdapterEnvironment(false), {});
});

test('a seeded divergence first fails the shared real and fake Git contract [C7]', () => {
  const root = process.cwd();
  const options = { cwd: root, encoding: 'utf8' };
  const head = realGitAdapter.spawnSync(['rev-parse', 'HEAD'], options).stdout.trim();
  assert.match(head, /^[a-f0-9]{40,64}$/u);
  const memory = createMemoryGitAdapter([{ root, branch: 'main', head, commits: [{ oid: head, tree: 'b'.repeat(40), files: {} }] }]);
  /** The same caller-visible contract is run against real Git and its fake. */
  const contract = adapter => assert.equal(adapter.spawnSync(['rev-parse', 'HEAD'], options).stdout, `${head}\n`);
  const broken = { ...memory, spawnSync: (...args) => ({ ...memory.spawnSync(...args), stdout: 'wrong\n' }) };
  assert.doesNotThrow(() => contract(realGitAdapter));
  assert.throws(() => contract(broken), assert.AssertionError, 'the shared contract exposes the seeded drift before correction');
  assert.doesNotThrow(() => contract(memory));
});


test('scheduled production audit runs Git real [C7]', { timeout: 180_000 }, async t => {
  const box = await mainAuditFixture(t, { requireRealGit: true });
  runFixtureExecFile('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  writeFileSync(join(box.directory, 'schedule.json'), JSON.stringify({ dueAt: new Date(Date.now() - 1000).toISOString() }));
  await box.startWorker({ scheduled: true }).finish();
  const job = JSON.parse(readFileSync(join(box.directory, `${box.key}.json`), 'utf8'));
  const receipt = box.readGateReceipt(box.receiptStore(box.repo), job.receiptId);
  assert.ok(receipt.collection.files.includes('test/c.test.js'));
  assert.equal(readFileSync(box.marker, 'utf8'), 'ran');
  assert.ok(!receipt.failures.some(failure => failure.name === 'audit uses real Git'), JSON.stringify(receipt.failures));
});
