/** A merge of main keeps lane ownership: foreign files main advanced never count, real outside edits do [L3,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { assertWaitsOnOwner } from '../../tests/fixtures/lanes-policy.js';
import { mergedMainFixture } from '../../tests/fixtures/lanes-policy.js';
import { policyFixtures } from '../../tests/fixtures/lanes-policy.js';

after(policyFixtures.cleanup);

test('a merge of main whose foreign-lane files advanced again still submits [L3,V4]', async () => {
  const box = await mergedMainFixture('Merged main');
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
});

test('a real outside-lane edit after the merge of main is refused by name [L3,V4]', async () => {
  const box = await mergedMainFixture('Edit after merge');
  mkdirSync(join(box.web, 'api'), { recursive: true });
  writeFileSync(join(box.web, 'api/stray.js'), 'outside\n');
  policyFixtures.attackCommit(box, box.web);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  await assertWaitsOnOwner(box, 1, submitted, 'api', ['api/stray.js']);
  const held = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_hold_reason;
  assert.equal(held.includes('coordinator.txt'), false, 'main-only files never count');
});
