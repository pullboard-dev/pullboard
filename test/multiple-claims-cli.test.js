/** Two ordinary CLI claims retain independent owners and frozen bars [B5,H16]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
test('one seat claims and renews two separate items through the CLI [B5,H16]', () => {
  const box = helpers.project();
  const add = title => {
    const result = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'the fixture works', '--json');
    assert.equal(result.code, 0, result.err); return JSON.parse(result.out).item.item_id;
  };
  const one = add('First fixture'), two = add('Second fixture');
  for (const item of [one, two, one, two]) {
    const result = box.run(box.web, 'claim', String(item)); assert.equal(result.code, 0, result.err);
  }
  const first = box.run(box.repo, 'show', String(one), '--json');
  const second = box.run(box.repo, 'show', String(two), '--json');
  assert.equal(first.code, 0, first.err); assert.equal(second.code, 0, second.err);
  const a = JSON.parse(first.out), b = JSON.parse(second.out);
  assert.equal(a.item_status, 'claimed'); assert.equal(b.item_status, 'claimed');
  assert.equal(a.item_owner, b.item_owner); assert.ok(a.item_frozen_digest); assert.ok(b.item_frozen_digest);
});
