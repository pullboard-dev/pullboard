/** A pulled land job runs the contracts its items' submits never proved and bisects a red batch to its item [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeTestTiers } from '../../../../../packages/gate/index.js';
import {
  json,
  commit,
  calls,
  fixture,
  build,
  accept,
} from '../../../tests/fixtures/test/selection.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';

test('clause 1: a real T3 batch failure bisects to its item while package units stay out of batch gates [C7,CS4,V4]', async t => {
  const box = fixture(t), good = build(box, 'alpha', 2);
  json(box, good.root, 'submit', String(good.id), '--no-next');
  accept(box, good);
  const bad = build(box, 'beta', 0, { second: true });
  json(box, bad.root, 'submit', String(bad.id), '--no-next');
  accept(box, bad);
  assert.deepEqual(calls(box, 'journey'), [], 'no journey ran during either submit or review');
  box.env.NODE_TEST_CONTEXT = 'child-v8'; // The batch must execute its independent journey runner too.
  const landing = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landing.code, 0, landing.out + landing.err);
  const landed = await settleLand(box, JSON.parse(landing.out));
  assert.deepEqual(landed.landed, [good.id], `${landing.err}\n${JSON.stringify(landed.landJob)}`);
  assert.deepEqual(landed.returned.map(row => row.id), [bad.id], JSON.stringify(landed.landJob));
  assert.equal(landed.returned[0].reason, 'red');
  assert.match(landed.returned[0].detail ?? '', /test\/journey\.test\.js/u, 'the red names the journey the batch gate ran');
  assert.ok(calls(box, 'journey').length > 0, 'the independent journey runner executed at landing');
  assert.ok(json(box, box.repo, 'show', String(good.id)).item_merged_commit);
  // Under separate publish the culprit parks on a hold, unmerged, while the clean item lands [C7].
  const culprit = json(box, box.repo, 'show', String(bad.id));
  assert.ok(!culprit.item_merged_commit && culprit.item_hold_at, JSON.stringify(culprit));
});


test('clause 1 control: a contract that reaches main after submit still runs at landing and blocks a change that breaks it [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  const submitted = await settleSubmit(t, box, json(box, entry.root, 'submit', String(entry.id), '--no-next'));
  assert.deepEqual(submitted.gate.files, ['test/alpha.test.js'], 'the submit proof predates the contract');
  accept(box, entry);
  mkdirSync(join(box.repo, 'packages/alpha/contract'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/alpha/contract/door.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { n } from '../index.js';
test('alpha keeps its front door value [G1]', () => { appendFileSync(${JSON.stringify(join(box.dir, 'contract.log'))}, 'contract:' + JSON.stringify(n) + '\\n'); assert.equal(n, 1); });
`);
  writeTestTiers(box.repo);
  commit(box, box.repo, 'test: alpha front door keeps its value [G1]');
  const blocked = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(blocked.code, 0, blocked.out + blocked.err);
  const landed = await settleLand(box, JSON.parse(blocked.out));
  assert.deepEqual(landed.landed, [], JSON.stringify(landed));
  assert.equal(landed.batch.state, 'blocked', JSON.stringify(landed.landJob));
  assert.ok(calls(box, 'contract').includes('contract:2'), 'landing ran the new contract on the merged tree');
  assert.ok(!json(box, box.repo, 'show', String(entry.id)).item_merged_commit, 'the change that breaks the contract never lands');
});
