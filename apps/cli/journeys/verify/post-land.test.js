/** next --verify hands out forced-landed items with no verdict, newest landing first, and never one that has a verdict [C7,#6490]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { forcedLandedUnreviewed } from '../../../../packages/verify/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  fixtureProjectPolicy,
} from '../../tests/fixtures/testkit.js';

/** A landed item: filed, then recorded as merged by hand the way the blitz lander lands it. */
async function landed(box, title) {
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title });
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const merged = await box.runLocal(box.repo, 'merged', String(item.item_id), commit, '--forced', 'blitz lander landed it before review', '--waive-proof', 'fixture', '--json');
  assert.equal(merged.code, 0, merged.out + merged.err);
  return item.item_id;
}

test('cli.journeys-verify-post-land.next-verify-offers-the-forced-landed: earlier 1: next --verify offers the forced-landed items with no verdict newest landing first, and with the setting off offers none [C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const older = await landed(box, 'Landed first');
  const newer = await landed(box, 'Landed second');
  const off = await box.runLocal(box.web, 'next', '--verify', '--json');
  assert.doesNotMatch(off.out, /landed, no verdict/u, 'default off: no landed review is offered');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { ...config.verify, landedReviews: true } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: offer landed reviews');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const first = await box.runLocal(box.web, 'next', '--verify', '--json');
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(JSON.parse(first.out).item.item_id, newer, 'the newest landing is offered first');
  assert.equal(JSON.parse(first.out).review, true);
  const accepted = await box.runLocal(box.web, 'verify', String(newer), 'accept', '--note', 'read the merge diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const second = await box.runLocal(box.web, 'next', '--verify', '--json');
  assert.equal(JSON.parse(second.out).item.item_id, older, 'the item that has a verdict is not offered again');
});

test('cli.journeys-verify-post-land.an-item-that-already-has-a: earlier 2: an item that already has a verdict is never offered again, and an unforced or submitted item is not a landed review [C7]', () => {
  const merge = (id, forced) => ({ event_id: id, event_kind: 'merged', event_detail: JSON.stringify({ forced }) });
  const items = [
    { item_id: 1, item_status: 'withdrawn', item_merged_commit: 'a', item_verdict: null },
    { item_id: 2, item_status: 'withdrawn', item_merged_commit: 'b', item_verdict: 'ACCEPT' },
    { item_id: 3, item_status: 'withdrawn', item_merged_commit: 'c', item_verdict: null },
    { item_id: 4, item_status: 'submitted', item_merged_commit: null, item_verdict: null },
    { item_id: 5, item_status: 'withdrawn', item_merged_commit: 'e', item_verdict: null },
  ];
  const events = { 1: [merge(10, true)], 2: [merge(20, true)], 3: [merge(30, true)], 4: [], 5: [merge(40, false)] };
  assert.deepEqual(forcedLandedUnreviewed(items, item => events[item.item_id]).map(item => item.item_id), [3, 1]);
});
