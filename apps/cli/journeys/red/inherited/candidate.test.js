/** A red only the candidate has stays red with its builder and never claims main's red [V1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RED_SPEC } from '../../../tests/fixtures/red/main-red.js';
import { addItems } from '../../../tests/fixtures/red/main-red.js';
import { builder } from '../../../tests/fixtures/red/main-red.js';
import { commit } from '../../../tests/fixtures/red/main-red.js';
import { fixture } from '../../../tests/fixtures/red/main-red.js';
import { gateFacts } from '../../../tests/fixtures/red/main-red.js';
import { put } from '../../../tests/fixtures/red/main-red.js';
import { settledRed } from '../../../tests/fixtures/red/main-red.js';

test('a candidate-only red keeps the plain red fact [V1,C7]', async t => {
  const green = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
  const box = fixture(t, { spec: RED_SPEC, source: green });
  const [, submitItem] = addItems(box, [
    { title: 'Repair unrelated gate row', specId: 'G1' },
    { title: 'Candidate-only submit', specId: 'G2' },
  ]);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
  commit(submitter.root, box.env, 'test(core): introduce candidate-only red [G2]');
  // The first result names main's missing receipt; the red settles again once main's green receipt records.
  const measured = doc => { const facts = (doc?.thread ?? []).map(entry => String(entry.text ?? '')).filter(text => / red at /u.test(text)); return facts.length > 0 && !/main receipt missing/u.test(facts.at(-1)); };
  const { shown, job } = await settledRed(t, box, submitter, submitItem, {
    args: ['--infra', 'introduce a candidate-only failing assertion to distinguish it from inherited failure'], until: measured });
  const facts = gateFacts(shown, job.id);
  assert.match(facts.at(-1), /^Gate job \S+ red at /u);
  assert.doesNotMatch(facts.at(-1), /also red on main|also fails on main|inherited main red|main not checked/u);
  assert.equal(shown.item_status, 'claimed');
});
