/** Without a focused runner in main's config, a pulled red says main was not checked and names the missing key [V1,C7]. */
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
import { runCount } from '../../../tests/fixtures/red/main-red.js';
import { settledRed } from '../../../tests/fixtures/red/main-red.js';

test('without a focused runner the red names the missing config key [V1,C7]', async t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST, affectedTests: '' });
  const [, submitItem] = addItems(box, [
    { title: 'Repair inherited gate', specId: 'G1' },
    { title: 'Unrelated submit', specId: 'G2' },
  ]);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): select red without focused runner [G2]');
  const before = runCount(box);
  const { shown, job } = await settledRed(t, box, submitter, submitItem, { args: ['--infra', 'append a candidate-only test marker to exercise missing focused-runner guidance'] });
  const facts = gateFacts(shown, job.id);
  assert.equal(facts.length, 1, facts.join('\n---\n'));
  assert.match(facts[0], /^Gate job \S+ red at /u);
  assert.match(facts[0], /main not checked: no focused test runner configured \(affectedTests\)/u);
  assert.equal(shown.item_status, 'claimed');
  assert.equal(runCount(box), before + 1, 'the main comparison does not run a second full gate');
});
