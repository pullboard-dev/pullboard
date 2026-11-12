/** Real committed selection and private review run only the changed units and frozen check [C7,CS4,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  json,
  commit,
  calls,
  fixture,
  build,
  accept,
} from '../../tests/fixtures/test/selection.js';

test('submit and review run only the changed package units and frozen check [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'alpha', 2);
  box.env.NODE_TEST_CONTEXT = 'child-v8'; // Deliberate inherited context must not skip the selected units.
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.deepEqual(submitted.gate.files, ['test/alpha.test.js']);
  // RFC 0006 A3: the repository root imports alpha's front door, so its hash changes and it runs beside alpha.
  assert.deepEqual(submitted.gate.testTiers.packages, ['.', 'packages/alpha']);
  assert.deepEqual(submitted.gate.testTiers.journeys, ['test/journey.test.js']);
  assert.equal(submitted.gate.check.checked, true);
  assert.deepEqual(submitted.gate.phasePlan.map(phase => phase.role), ['criterion', 'proof']);
  assert.deepEqual(calls(box, 'alpha'), ['alpha:2']);
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
  accept(box, entry);
  assert.deepEqual(calls(box, 'alpha'), ['alpha:2'], 'review reuses the submit proof of the package unit instead of running it again');
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
});

test('a journey test the change itself edits runs at submit, not first at landing [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const journey = join(entry.root, 'test/journey.test.js');
  writeFileSync(journey, readFileSync(journey, 'utf8').replace("'journey\\n'", "'journey-edited\\n'"));
  const head = commit(box, entry.root, 'test(web): the journey records its edit [G1]');
  assert.notEqual(head, entry.head);
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.ok(submitted.gate.files.includes('test/journey.test.js'), submitted.gate.files.join(', '));
  assert.deepEqual(submitted.gate.testTiers.journeys, []);
  assert.deepEqual(calls(box, 'journey'), ['journey-edited']);
});

test('a red in a journey test the change edits turns the submit gate red [C7,CS4,V4]', async t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const journey = join(entry.root, 'test/journey.test.js');
  writeFileSync(journey, readFileSync(journey, 'utf8').replace('assert.ok(alpha > 0 && beta > 0)', 'assert.ok(alpha < 0, "edited journey is red")'));
  commit(box, entry.root, 'test(web): the journey asserts the wrong sign [G1]');
  const result = await box.runLocal(entry.root, 'submit', String(entry.id), '--no-next', '--json');
  assert.notEqual(result.code, 0, 'a red edited journey must not submit green');
  assert.match(result.out + result.err, /journey\.test\.js/u);
  assert.ok(calls(box, 'journey').length >= 1, 'the edited journey ran at submit');
});

test('a package with no units runs only its frozen check [C7,CS4,V4]', t => {
  const box = fixture(t), entry = build(box, 'gamma', 2);
  const submitted = json(box, entry.root, 'submit', String(entry.id), '--no-next');
  assert.deepEqual(submitted.gate.files, []);
  assert.deepEqual(submitted.gate.testTiers.units, []);
  assert.equal(submitted.gate.check.green, true);
  assert.deepEqual(submitted.gate.phasePlan.map(phase => phase.role), ['criterion']);
  assert.equal(submitted.gate.proofReceiptIds.length, 1, 'one real frozen proof and no unit phase');
  assert.deepEqual(calls(box, 'alpha'), []);
  assert.deepEqual(calls(box, 'beta'), []);
  assert.deepEqual(calls(box, 'journey'), []);
});
