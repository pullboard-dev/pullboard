/** A seat that holds a claim still resumes it above machine.loadCeiling, split from load-ceiling.test.js [C7,#9703]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { injectLoad } from '../../fixtures/next/take.js';
import { machineSettings } from '../../fixtures/next/take.js';

test('cli.io-next-resumes.above-ceiling-holder-resumes: clause 2: above the ceiling a seat that holds a claim still resumes it [C7,#9703]', async t => {
  const box = await fixture(t);
  const mine = box.add('Held by the actor');
  box.claim(mine, box.seats.actor);
  box.add('Open build');
  machineSettings({ holdAboveLoad: true });
  injectLoad(t, 30);
  const resumed = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, mine, 'the held claim comes back');
  assert.equal(resumed.document.held, true);
});
