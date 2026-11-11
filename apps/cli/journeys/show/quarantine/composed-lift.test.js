/** @pullboard-test-input source-tree */
/** After two real composed Submit pairs, twenty clean native runs lift the filed quarantine [C7,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { snapshot } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { submit } from '../../../tests/fixtures/cases/quarantine-submit.js';

test('clause 1: twenty clean runs lift the quarantine two composed Submit pairs filed [C7,H16]', t => {
  const box = fixture(t, false, true);
  const first = submit(box);
  assert.equal(first.code, 1, JSON.stringify(first.document));
  assert.equal(submit(box).code, 0); // the active quarantine lets the computed verdict through
  const cleanIds = new Set();
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(box.counter, 'run\n'); // The real next controlled body passes.
    const clean = box.cli('gate', '--landing', '--receipt');
    assert.equal(clean.code, 0, JSON.stringify(clean.document));
    assert.ok(clean.document.receiptId, 'each clean body produces fresh native receipt evidence');
    cleanIds.add(clean.document.receiptId);
  }
  assert.equal(cleanIds.size, 20, 'twenty actual executions, never a reused green stamp');
  assert.equal(snapshot(box).quarantines[0].status, 'lifted', 'the Submit backfill files an ordinary quarantine, which the 20-clean-run release lifts (f562d717d8)');
  assert.equal(snapshot(box).quarantines.length, 1, 'later admissions retain one active repair');
  assert.equal(box.cli('show', String(box.id)).document.item_status, 'submitted');
});
