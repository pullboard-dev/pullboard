/** A pulled red that main fails too names the open rework that owns it, and that rework leads its tier [V1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAILING_TEST } from '../../../tests/fixtures/red/main-red.js';
import { RED_SPEC } from '../../../tests/fixtures/red/main-red.js';
import { addItems } from '../../../tests/fixtures/red/main-red.js';
import { builder } from '../../../tests/fixtures/red/main-red.js';
import { commit } from '../../../tests/fixtures/red/main-red.js';
import { fixture } from '../../../tests/fixtures/red/main-red.js';
import { gateFacts } from '../../../tests/fixtures/red/main-red.js';
import { put } from '../../../tests/fixtures/red/main-red.js';
import { settledRed } from '../../../tests/fixtures/red/main-red.js';

test('a pulled inherited red names its open rework, which stays first in its tier [V1,C7]', async t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST });
  const [rework, submitItem] = addItems(box, [
    { title: 'First same-tier rework', specId: 'G1' },
    { title: 'Second same-tier submit', specId: 'G2' },
  ]);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): capture inherited red [G1]');
  // The first result names main's missing receipt; once its main-test job records, the red is main's and is accepted.
  const { shown, job } = await settledRed(t, box, submitter, submitItem, {
    args: ['--infra', 'append a candidate-only test marker to exercise prioritized inherited rework'], until: doc => doc?.item_status === 'submitted' });
  const accepted = gateFacts(shown, job.id).find(text => text.includes("(not this item's; accepted)"));
  assert.ok(accepted, gateFacts(shown, job.id).join('\n---\n'));
  assert.match(accepted, /^also red on main: test\/inherited\.test\.js$/mu);
  assert.match(accepted, new RegExp(`^inherited main red for approved row G1 \\(test/inherited\\.test\\.js\\); open rework #${rework} owns it$`, 'mu'));
  assert.doesNotMatch(accepted, /^next: /mu, 'an accepted red is not submitted again');
  const next = builder(box).run('next', '--json');
  assert.equal(next.code, 0, next.err);
  assert.equal(JSON.parse(next.out).item.item_id, rework);
});
