/** pullboard capacity --json reports the push shard count it would pick and the numbers behind it [C7,U151,#9391]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { pushGateReport } from '../../../src/io/hook/push.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 1: capacity --json carries a pushGate object, null where an input is unknown, and the text names the shard count [C7,U151]', async () => {
  const box = e2e.project();
  const json = await box.runLocal(box.repo, 'capacity', '--json');
  assert.equal(json.code, 0, `${json.err}\n${json.out}`);
  const { pushGate } = JSON.parse(json.out).report;
  for (const key of ['shards', 'targetMs', 'runners', 'totalMs', 'fileCount']) assert.ok(key in pushGate, `pushGate holds ${key}`);
  for (const value of Object.values(pushGate)) assert.notEqual(value, 0, 'an unknown input is null, never zero');
  assert.equal(pushGate.runners, null, 'a fresh board has no live runner');
  const text = await box.runLocal(box.repo, 'capacity');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^push gate: (\d+|unknown) shards \(/mu);

  const unknown = pushGateReport(null, {}, {}, undefined);
  assert.deepEqual([unknown.shards, unknown.totalMs, unknown.fileCount, unknown.runners], [null, null, null, null]);
  const sized = pushGateReport(['a.test.js', 'b.test.js', 'c.test.js'], { 'a.test.js': 600_000, 'b.test.js': 600_000, 'c.test.js': 600_000 }, { pushGate: { sizeFromBoard: true, shardMinutes: 20 } }, 4);
  assert.deepEqual([sized.shards, sized.totalMs, sized.fileCount, sized.runners, sized.targetMs], [3, 1_800_000, 3, 4, 300_000]);
  assert.equal(pushGateReport(['a.test.js', 'b.test.js'], {}, {}, 3).shards, 2, 'setting off: the fixed plan, capped by the file count');
});

test('clause 2: the push gate report only reads: inputs are left unchanged and the plan is repeatable [C7,U151]', () => {
  const files = ['a.test.js', 'b.test.js'];
  const times = { 'a.test.js': 1000 };
  const config = { pushGate: { sizeFromBoard: true } };
  const before = JSON.stringify([files, times, config]);
  const first = pushGateReport(files, times, config, 2);
  assert.deepEqual(pushGateReport(files, times, config, 2), first);
  assert.equal(JSON.stringify([files, times, config]), before);
});
