/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixture } from '../../tests/fixtures/landing/receipts.js';
import { verifiedItem } from '../../tests/fixtures/landing/receipts.js';
import { gate } from '../../tests/fixtures/landing/receipts.js';
import { onBoard } from '../../tests/fixtures/landing/receipts.js';

test('a required train landing refuses missing, mismatched and red native receipts before any merged event [C7]', async t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const before = onBoard(box, board => store.getItem(board, id));
  const missing = await box.runLocal(box.repo, 'merged', String(id), 'HEAD', '--json');
  assert.equal(missing.code, 1, missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'LAND_RECEIPT_REQUIRED');
  assert.deepEqual(onBoard(box, board => store.getItem(board, id)), before);
  const green = gate(box);
  const red = gate(box, true);
  for (const receipt of [red, { id: randomUUID() }]) {
    const result = await box.runLocal(box.repo, 'merged', String(id), 'HEAD', '--gate-receipt', receipt.id, '--json');
    assert.equal(result.code, 1, result.out);
    assert.equal(JSON.parse(result.out).error.code, 'LAND_RECEIPT_UNBOUND');
  }
  const old = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(box.repo, 'web/later.txt'), 'different committed source\n');
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: change native receipt source');
  const mismatch = await box.runLocal(box.repo, 'merged', String(id), 'HEAD', '--gate-receipt', green.id, '--json');
  assert.equal(mismatch.code, 1, mismatch.out);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD').trim(), old);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_merged_commit), null);
});
