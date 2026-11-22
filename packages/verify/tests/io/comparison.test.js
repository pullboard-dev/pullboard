/** A review comparison worker runs its body when started through a symlinked folder, as the temp tools snapshot is (#11709). */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAsEntry } from '../fixtures/entry.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { showReads } from '../../read.js';

const SOURCE = fileURLToPath(new URL('../../src/io/comparison.js', import.meta.url));

test('verify.comparison.entry-through-symlink: [C7] a worker started through a symlinked folder runs its body, as through the real path', (t) => {
  const scratch = privateFixtureFiles('pullboard-comparison-entry-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const link = join(scratch, 'tools');
  symlinkSync(dirname(SOURCE), link, 'dir');
  const missing = join(scratch, 'absent', 'request.json');
  for (const script of [join(link, 'comparison.js'), SOURCE]) {
    const run = startAsEntry(script, [missing]);
    assert.notEqual(run.status, 0, `${script} exited ${run.status} without running the worker body`);
    assert.match(run.stderr, /ENOENT/u);
    assert.ok(run.stderr.includes(missing), 'the refusal names the missing request');
  }
});

test('verify.io-comparison.show-recorded-parity: clause 1: show reads the matching recorded comparison and renders its run identities without executing tests [C7]', async () => {
  const { recordedVerificationComparison, renderVerificationComparison } = await showReads();
  const item = { item_id: 12, item_commit: 'head', item_frozen_digest: 'digest' };
  const thread = [{ type: 'fact', text: 'Review comparison: ' + JSON.stringify({ source: 'old', digest: 'digest' }) },
    { type: 'fact', text: 'Review comparison: ' + JSON.stringify({ source: 'head', digest: 'digest', status: 'complete' }) }];
  const result = recordedVerificationComparison(thread, item);
  assert.deepEqual(result, { source: 'head', digest: 'digest', status: 'complete' });
  assert.equal(renderVerificationComparison({ item: 12, headCommit: 'head', baseCommit: 'base',
    head: { id: 'run-head' }, base: { id: 'run-base' }, newRed: [], fixed: [] }),
  'comparison #12\nhead head: run run-head\nbase base: run run-base\nNo new red or fixed cases.');
  assert.equal(recordedVerificationComparison(thread, { ...item, item_frozen_digest: 'changed' }), null);
});
