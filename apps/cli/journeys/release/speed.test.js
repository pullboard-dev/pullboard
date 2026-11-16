/** @pullboard-test-input source-tree */
/** Release placement and receipt boundaries; synthetic models do not claim a real eight-node timed release [C7,I15]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installReleaseReceiptCases } from '../../tests/fixtures/release/cases/receipt.js';
import { installReleaseTransportCases } from '../../tests/fixtures/release/cases/transport.js';
import '../../tests/fixtures/cases/affinity.js';
import {
  planReleaseShards,
  releasePlacement,
} from '../../../../packages/landing/index.js';
import { releaseParticipation } from '../../../../packages/gate/index.js';
import { releaseReceiptFields } from '../../../../packages/gate/index.js';
import { releaseReceiptProblem } from '../../../../packages/gate/index.js';
import { releaseParticipationDigest } from '../../../../packages/gate/index.js';
import { releaseTiming } from '../../../../packages/gate/index.js';
import { RELEASE_BUDGET_SECONDS } from '../../../../packages/gate/index.js';
import { releaseReceiptFixture } from '../../tests/fixtures/release/cases/receipt.js';
import { RELEASE_PARTICIPATION_PREFIX } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';

installReleaseReceiptCases();
installReleaseTransportCases();

/** An explicit model of registered capacity, not observations or receipts from the person's machines. */
function targets() {
  return [{ id: 'local:synthetic-macbook', kind: 'local', browser: true, gui: true },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `synthetic-ssh-${i}`, host: `synthetic-ssh-${i}`, kind: 'ssh', browser: true, gui: false }))];
}

test('release partitions tracked work across every required executor without moving CPU-only work onto local [C7,Q1,I15]', async () => {
  const executors = targets();
  const files = ['test/cpu.test.js', 'test/gui.test.js', ...Array.from({ length: 10 }, (_, i) => `test/ordinary-${i}.test.js`)];
  const plan = await planReleaseShards(files, executors, { 'test/cpu.test.js': 999999 }, async () => true,
    async names => names.includes('test/gui.test.js'), async names => names.includes('test/cpu.test.js'));
  assert.equal(plan.length, 8);
  assert.ok(plan.every(shard => shard.files.length > 0));
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), [...files].sort());
  assert.equal(plan.find(shard => shard.files.includes('test/gui.test.js')).executor.kind, 'local');
  assert.equal(plan.find(shard => shard.files.includes('test/cpu.test.js')).executor.kind, 'ssh');
  const nine = [...executors, { ...executors[1], id: 'synthetic-extra', host: 'synthetic-extra' }];
  assert.equal((await planReleaseShards(files, nine, {}, async () => false, async () => false)).length, 9,
    'every registered executor is required, not a hardcoded eight-shard count');
});

test('release placement refuses missing changed or incompatible executors and ambiguous observations [C7,Q1,I15]', async () => {
  const executors = targets();
  const files = Array.from({ length: 8 }, (_, i) => `test/ordinary-${i}.test.js`);
  await assert.rejects(planReleaseShards(files, []), /nonempty/);
  await assert.rejects(planReleaseShards(files.slice(1), executors), /nonempty/);
  await assert.rejects(planReleaseShards(files, executors, {}, async () => true, async () => true), /compatible/);
  const value = { version: 1, id: '6af8c70a-65f0-4a61-8040-3f1f278d9a10', executors };
  assert.deepEqual(releasePlacement(JSON.stringify(value), executors), value);
  assert.throws(() => releasePlacement(JSON.stringify({ ...value, executors: executors.slice(1) }), executors), /changed|incomplete/);
  const line = RELEASE_PARTICIPATION_PREFIX + JSON.stringify({ id: value.id, explicitlySynthetic: true }) + '\n';
  assert.equal(releaseParticipation(line, value.id).explicitlySynthetic, true);
  assert.equal(releaseParticipation(line + line, value.id), null, 'duplicate protocol observations cannot establish custody');
  assert.equal(releaseParticipation(RELEASE_PARTICIPATION_PREFIX + 'broken\n', value.id), null);
});

test('a release request with no executors refuses before running or leaving a green stamp [C7,I15]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node -e "process.exit(99)"', undefined, { withWorktree: false });
  const source = `import assert from 'node:assert/strict';
import {runGate} from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
${executionServicesSource(new URL('../../../../packages/gate/index.js', import.meta.url).href)}
await assert.rejects(runGate(process.cwd(),{gate:'node -e "process.exit(99)"'},
 { executionServices,trustStamp:false,landing:true,collectAll:true,releaseRequest:{version:1,id:'6af8c70a-65f0-4a61-8040-3f1f278d9a10',executors:[]}}),
 error=>error.code==='GATE_RUN_EVIDENCE');`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.failure);
  assert.equal(existsSync(join(box.repo, '.git', 'pullboard-gate-green')), false);
});

for (const count of [1, 7]) {
  test(`release partitions work across the actual ${count}-executor registry [C7,I15]`, async () => {
    const executors = targets().slice(0, count);
    const files = Array.from({ length: 8 }, (_, i) => `test/ordinary-${i}.test.js`);
    const plan = await planReleaseShards(files, executors, {}, async () => false, async () => false);
    assert.equal(plan.length, count);
    assert.deepEqual(plan.map(shard => shard.executor.id).sort(), executors.map(executor => executor.id).sort());
    assert.ok(plan.every(shard => shard.files.length > 0));
    assert.deepEqual(plan.flatMap(shard => shard.files).sort(), files.sort());
  });
}

/** A synthetic eight-executor envelope whose participation runs `minutes` long, carrying the timing a producer records. */
function timedRelease(minutes) {
  const { envelope, expected } = releaseReceiptFixture();
  envelope.participation.finishedAt = new Date(Date.parse(envelope.participation.startedAt) + minutes * 60_000).toISOString();
  envelope.gateReceipt.participationDigest = releaseParticipationDigest(envelope.participation);
  envelope.timing = releaseTiming(envelope.participation);
  return { envelope, expected };
}

test('a release under 15 minutes records its wall time [C7,I15]', () => {
  assert.equal(RELEASE_BUDGET_SECONDS, 900);
  const { envelope, expected } = timedRelease(14);
  assert.equal(releaseReceiptProblem(envelope, expected), null);
  const timing = releaseReceiptFields(envelope, expected).timing;
  assert.deepEqual(timing, { startedAt: envelope.participation.startedAt, finishedAt: envelope.participation.finishedAt,
    seconds: 840, budgetSeconds: 900, status: 'WITHIN_BUDGET' });
  const old = structuredClone(envelope);
  delete old.timing;
  assert.equal(releaseReceiptProblem(old, expected), null, 'receipt bytes recorded before timing existed stay valid');
  assert.equal(Object.hasOwn(releaseReceiptFields(old, expected), 'timing'), false);
  const lie = structuredClone(envelope);
  lie.timing.seconds = 1;
  assert.notEqual(releaseReceiptProblem(lie, expected), null, 'a recorded wall time must match the observed interval');
});

test('a release over 15 minutes is marked OVER_BUDGET [C7,I15]', () => {
  const { envelope, expected } = timedRelease(16);
  assert.equal(releaseReceiptProblem(envelope, expected), null, 'the slow release is still a recorded, valid receipt');
  const timing = releaseReceiptFields(envelope, expected).timing;
  assert.equal(timing.seconds, 960);
  assert.equal(timing.status, 'OVER_BUDGET');
  assert.equal(releaseTiming(envelope.participation, 960).status, 'WITHIN_BUDGET', 'the verdict is exactly seconds past the budget');
  const hidden = structuredClone(envelope);
  hidden.timing.status = 'WITHIN_BUDGET';
  assert.notEqual(releaseReceiptProblem(hidden, expected), null, 'a slow release cannot be relabelled within budget');
});
