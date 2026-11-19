/** The contribution record cases live beside their cell; this entry runs them for the item's frozen check path [CR2,CR5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContributionRecord } from '../../../index.js';
import '../contribution.test.js';

test('commits.logic-contribution-main.entry-reports-its-own-case: clause 1: the entry file reports one case under its own path, so a gate that selects it finds a test account for it [C7]', () => {
  assert.equal(typeof parseContributionRecord, 'function');
});
