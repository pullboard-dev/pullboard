/** The last release is the highest vMAJOR.MINOR.PATCH tag by number, whatever else the repository has tagged [C7,R4,U150]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastReleaseTag } from '../../../index.js';

test('moves.last-release.highest-by-number: clause 1: lastReleaseTag picks the highest release tag comparing each part as a number [C7,R4]', () => {
  assert.equal(lastReleaseTag(['v0.9.9', 'v0.10.0', 'v0.9.10']), 'v0.10.0');
  assert.equal(lastReleaseTag(['v0.9.9', 'v0.9.10']), 'v0.9.10');
  assert.equal(lastReleaseTag(['v1.0.0', 'v0.99.99']), 'v1.0.0');
  assert.equal(lastReleaseTag(['v0.9.4']), 'v0.9.4');
});

test('moves.last-release.skips-other-tags: clause 2: lastReleaseTag skips prerelease, unprefixed and other tags, and gives null when none is a release [C7,R4]', () => {
  assert.equal(lastReleaseTag(['v0.9.4', 'v0.9.5-rc.1', '0.9.5', 'nightly']), 'v0.9.4');
  assert.equal(lastReleaseTag(['v0.9.5-rc.1', '0.9.5', 'nightly', 'v1']), null);
  assert.equal(lastReleaseTag([]), null);
  assert.equal(lastReleaseTag(undefined), null);
});

test('moves.last-release.order-free-and-pure: clause 3: lastReleaseTag gives the same answer in any order and leaves its list unchanged [C7,R4]', () => {
  const tags = ['nightly', 'v0.9.10', 'v0.9.9', 'v0.10.0', 'v0.10.0-rc.2', 'v0.2.0'];
  const before = [...tags];
  const answers = new Set([tags, [...tags].reverse(), [...tags].sort(), [...tags].sort().reverse()].map((order) => lastReleaseTag(order)));
  assert.deepEqual([...answers], ['v0.10.0']);
  assert.deepEqual(tags, before);
});
