/** Below the ceiling, and with next.holdAboveLoad off, next hands claims as before; split from load-ceiling.test.js so each file runs under a minute on a loaded runner [C7,#9703]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { injectLoad } from '../../fixtures/next/take.js';
import { machineSettings } from '../../fixtures/next/take.js';

test('cli.io-next-load-ceiling-below.cli-next-load-ceiling-below-the-ceiling: cli.next.load-ceiling.below-the-ceiling-next-hands-claims: clause 3: below the ceiling next hands claims as before, and the hold is off by default [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 2);
  const below = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(below.code, 0, below.out + below.err);
  assert.equal(below.document.item.item_id, open, 'below the ceiling the build is handed over');
});

test('cli.io-next-load-ceiling-below.cli-next-load-ceiling-with-next-holdaboveload: cli.next.load-ceiling.with-next-holdaboveload-off-a-load: clause 3: with next.holdAboveLoad off, a load above the ceiling changes nothing [C7,#9703]', async t => {
  const box = await fixture(t);
  const open = box.add('Open build');
  machineSettings({});
  injectLoad(t, 30);
  const off = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(off.code, 0, off.out + off.err);
  assert.equal(off.document.item.item_id, open);
});
