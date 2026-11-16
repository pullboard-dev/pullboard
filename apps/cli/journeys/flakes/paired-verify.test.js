/** @pullboard-test-input source-tree */
import { flakyProject } from '../../../../packages/git/tests/fixtures/flakes.js';
import { targetRuns } from '../../../../packages/git/tests/fixtures/flakes.js';
import { privateBuilder } from '../../../../packages/git/tests/fixtures/flakes.js';
import { commitCandidate } from '../../../../packages/git/tests/fixtures/flakes.js';
import { settledCommit } from '../../../../packages/git/tests/fixtures/flakes.js';
import { checkedItem } from '../../../../packages/git/tests/fixtures/flakes.js';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
/** Native flake observations: private verification reruns on one green check [C7,V4,H16]. */

for (const linkedTemp of [false, true]) test(linkedTemp
  ? 'a private verification accepts on one green check run through a symlinked temporary root [C7,V4,H16]'
  : 'an independent private verification accepts on one green check run and makes no pair [C7,V4,H16]', async t => {
  const box = flakyProject(t, { alwaysPass: 'controlled' });
  if (linkedTemp) {
    const alias = join(box.scratch, 'temporary-alias');
    symlinkSync(box.scratch, alias, 'dir');
    box.env.TMPDIR = alias;
  }
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = await builder.call('claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: controlled review candidate');
  const submitted = await builder.call('submit', String(id));
  assert.equal(submitted.code, 0, 'the fixture submits with a real green proof before its external failure is enabled');
  const head = await settledCommit(box, id);
  writeFileSync(box.counter, ''); writeFileSync(box.counter + '.mode', 'paired');
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const result = await reviewer.call('verify', String(id), 'accept');
  // Changed today: the verify rerun of the check is a single green run (no CHECK_RED), so no diagnostic pair is made.
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(result.document.check, 'green');
  const item = (await box.call('show', String(id))).document;
  assert.equal(item.item_verdict, 'ACCEPT', 'verify accepts on its one green check run');
  assert.equal(targetRuns(box), 1, 'verify reruns the private check once, green, and nothing else');
  assert.equal((await box.call('flakes')).document.flakes.length, 0, 'a verdict records no flake observation');
});
