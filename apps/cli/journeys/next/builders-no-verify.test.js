/** review.builderOffers keeps a builder's next from offering or reserving a review while a seat in lane review is alive, and is off by default [C7,#11946]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Write this fixture machine's review settings, keeping the settings the fixture wrote. */
function reviewSettings(review) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, review }));
}

/** One submitted review waiting, and one open build item, with the fixture's review-lane seats alive. */
function reviewAndBuild(box) {
  const review = box.add('Submitted work waiting for review', { route: 'light' });
  box.submit(review);
  const build = box.add('The open build item', { route: 'light' });
  return { review, build };
}

test('cli.journeys-next-builders-no-verify.real-entry-no-live-review-seat: clause 3: the real CLI entry apps/cli/pullboard.js with review.builderOffers on and no review-lane seat alive offers the waiting review to a builder seat [C7,#11946]', async t => {
  const box = await fixture(t, { route: 'light' });
  const { review } = reviewAndBuild(box);
  reviewSettings({ builderOffers: true });
  assert.ok(Date.now() > box.clock.now().getTime() + 1_800_000, 'the real clock is past the fixture heartbeats, so no review-lane seat is alive');
  const ran = await runCliInProcess(['next', '--json'], { cwd: box.seats.actor.path, env: process.env });
  assert.equal(ran.status, 0, ran.out + ran.err);
  assert.equal(JSON.parse(ran.stdout).item.item_id, review);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
});
