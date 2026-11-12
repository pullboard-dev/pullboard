/** Doctor names a frozen gate whose test file is missing and finishes at once [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

test('doctor on a verified item whose gate names a missing file finishes and names that file [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.privateCheckSubmission({ check: 'node --test test/cockpit.test.js' });
  // Scratch board owned by this fixture: mark the submission verified so doctor audits its frozen check.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'));
  try { db.prepare("UPDATE item SET item_status='verified' WHERE item_id=1").run(); } finally { db.close(); }
  const result = box.run(box.repo, 'doctor');
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out + result.err, /test\/cockpit\.test\.js/u);
  assert.match(result.out + result.err, /GATE_FILE_MISSING|does not exist/u);
});
