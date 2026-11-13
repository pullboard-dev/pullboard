/** Native submit accepts a plan row for an item-created file and refuses one for a main file [L3,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { whenRunnerSettles } from '../../tests/fixtures/runner/local-start.js';
import { policyFixtures } from '../../tests/fixtures/lanes-policy.js';
import { assertWaitsOnOwner } from '../../tests/fixtures/lanes-policy.js';
import { nativePlanRowFixture } from '../../tests/fixtures/lanes-policy.js';
import { nativePlanRowItem } from '../../tests/fixtures/lanes-policy.js';
import { commitPlanRow } from '../../tests/fixtures/lanes-policy.js';

after(policyFixtures.cleanup);

test('native submit accepts a plan row for an item file after reclaim and refreeze while main lacks it [L3,C7,#2108]', async t => {
  const { box, shardPath } = await nativePlanRowFixture(t);
  const id = await nativePlanRowItem(box, 'Place an item-created source file');
  mkdirSync(join(box.web, 'src'), { recursive: true });
  writeFileSync(join(box.web, 'src/new.js'), 'export {};\n');
  box.git(box.web, 'add', 'src/new.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): create planned source [G1]', '-m', `Pullboard-Item: #${id}`);
  const ownCommit = box.git(box.web, 'rev-parse', 'HEAD');
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'BLOCKED', '--note', 'reclaim after the item source commit', '--json');
  assert.equal(released.code, 0, released.err + released.out);
  const refrozen = await box.runLocal(box.repo, 'refreeze', String(id), '--json');
  assert.equal(refrozen.code, 0, refrozen.err + refrozen.out);
  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'show', String(id), '--json')).out).item_claim_head, ownCommit,
    'the reclaim uses the item commit as its new base');
  commitPlanRow(box, id, shardPath, 'src/new.js');
  const submitted = await box.runLocal(box.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  // The board applies the pulled receipt just after the job row closes, so settle on the item leaving its claim [P7].
  const shown = await whenRunnerSettles(box.env, async () => {
    const row = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
    return row.item_status !== 'claimed' ? row : null;
  }, { deadlineMs: 120_000, what: `the pulled gate of #${id} to apply` });
  assert.equal(shown.item_status, 'submitted', JSON.stringify(shown.thread.filter(row => row.type === 'fact').map(row => row.text)).slice(-3000));
});

test('native submit refuses a plan row for a file already present on main [L3,C7,#2108]', async t => {
  const { box, shardPath } = await nativePlanRowFixture(t, { mainFile: 'src/already-main.js' });
  const id = await nativePlanRowItem(box, 'Refuse a plan row for a main file');
  commitPlanRow(box, id, shardPath, 'src/already-main.js');
  // The plan shard is no web path, so ownership routing sends the row to its owner rather than landing it (814a7def2a).
  await assertWaitsOnOwner(box, id, await box.runLocal(box.web, 'submit', String(id), '--json'), 'coordinator', [shardPath]);
});
