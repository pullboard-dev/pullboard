/** next.capBuilders sends a build seat to a waiting review once that many other seats hold claims, and is off by default [C7,#8545]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Write this fixture machine's next settings, keeping the settings the fixture wrote. */
function nextSettings(next) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next }));
}

/** One review waiting, one open build, and one other seat already holding a claim. */
function crowded(box) {
  const review = box.add('Review waiting');
  box.submit(review);
  const held = box.add('Built by another seat');
  box.claim(held);
  const open = box.add('Open build');
  return { review, held, open };
}

test('clause 1: with next.capBuilders on and builders past the cap, next offers a review instead of a build [C7,#8545]', async t => {
  const box = await fixture(t);
  const { review, open } = crowded(box);
  nextSettings({ capBuilders: 1 });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, review, 'the waiting review is offered');
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
  assert.equal(store.getItem(box.board, open).item_status, 'open', 'the open build stays unclaimed');
});

test('clause 2: next.capBuilders is off by default and next offers the build as before [C7,#8545]', async t => {
  const box = await fixture(t);
  const { open } = crowded(box);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take', '--build']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, open, 'with the setting unset the build is claimed');
  nextSettings({ capBuilders: 0 });
  const again = await cli(box, box.seats.actor.path, ['next', '--take', '--build']);
  assert.equal(again.document.item.item_id, open, 'a cap of 0 is off too');
});
