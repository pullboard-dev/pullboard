/** A pulled land job's contracts hold no landing for a test main already fails, and still return a new red [C7,#7458]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeTestTiers } from '../../../../../packages/gate/index.js';
import {
  json,
  commit,
  fixture,
  build,
  accept,
} from '../../../tests/fixtures/test/selection.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';

/** Put a contract on main for the alpha package's front door: `cases` are test bodies by name, each reading n [C7]. */
function mainContract(box, cases) {
  mkdirSync(join(box.repo, 'packages/alpha/contract'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/alpha/contract/known.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { n } from '../index.js';
${Object.entries(cases).map(([name, body]) => `test(${JSON.stringify(name)}, () => { ${body} });`).join('\n')}
`);
  writeTestTiers(box.repo);
  commit(box, box.repo, 'test: alpha front door contract [G1]');
}

test('clause 1: a contract red only where the merged base is red too records a known main red and the item lands [C7,#7458]', async t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  await settleSubmit(t, box, json(box, entry.root, 'submit', String(entry.id), '--no-next'));
  accept(box, entry);
  mainContract(box, { 'alpha front door is already red on main [G1]': 'assert.equal(n, 99);' });
  const landed = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(landed.landed, [entry.id], JSON.stringify(landed.landJob));
  assert.deepEqual(landed.landJob.receipt.contracts.mainRed, [{ file: 'packages/alpha/contract/known.test.js', name: 'alpha front door is already red on main [G1]' }], 'the receipt records the known main red');
  assert.ok(json(box, box.repo, 'show', String(entry.id)).item_merged_commit, 'a red main already has holds no landing');
});

test('clause 2: a contract case green on the base and red on the merged tree returns its culprit beside a known main red [C7,#7458]', async t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  await settleSubmit(t, box, json(box, entry.root, 'submit', String(entry.id), '--no-next'));
  accept(box, entry);
  mainContract(box, { 'alpha front door is already red on main [G1]': 'assert.equal(n, 99);', 'alpha front door keeps its value [G1]': 'assert.equal(n, 1);' });
  const landed = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(landed.landed, [], JSON.stringify(landed.landJob));
  assert.equal(landed.batch.state, 'blocked', JSON.stringify(landed.landJob));
  assert.equal(landed.landJob.receipt.contracts.mainRed, undefined, 'a new red is never recorded as main\'s');
  assert.match(landed.landJob.receipt.detail ?? '', /alpha front door keeps its value/u, 'the red names the case the merge broke');
  assert.ok(!json(box, box.repo, 'show', String(entry.id)).item_merged_commit, 'the change that breaks the contract never lands');
});
