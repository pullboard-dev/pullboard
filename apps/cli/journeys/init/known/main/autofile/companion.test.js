/** An opted-in submit with a docs companion files its untouched main failure, settled through the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixture,
  cli,
  rows,
  settledSubmit,
} from '../../../../../tests/fixtures/affected.js';

test('an opted-in submit with a real docs companion files its untouched main failure [V4,B3]', async t => {
  const box = fixture(t, { autoFileMainReds: true, companion: true });
  const author = JSON.parse(cli(box, box.builder, 'whoami').stdout).id;
  const patch = join(box.directory, 'autofile-companion.patch');
  writeFileSync(patch, 'diff --git a/docs/companion.md b/docs/companion.md\n--- a/docs/companion.md\n+++ b/docs/companion.md\n@@ -1 +1 @@\n-Before.\n+After.\n');
  const attached = cli(box, box.root, 'patch', 'attach', String(box.item), patch, '--key', 'autofile-docs', '--author', author, '--source', box.head);
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  const report = await settledSubmit(t, box);
  const known = report.submission?.submissionProof?.knownMainFailures;
  assert.equal(known?.main, box.main, JSON.stringify(report.submission));
  assert.deepEqual(known.failures.map(row => row.file), ['test/affected.test.js']);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});
