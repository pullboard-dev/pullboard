/** The public, versioned JSON surface of every pullboard command (A1): the command results cases of the catalog [A1,C7,#9675]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogGroups } from '../../../tests/fixtures/catalog/cases.js';

test('cli.journeys-publish-catalog-results-a1.the-results-a1-group-of-catalog: clause 2: the results-a1 group of catalog cases has a real CLI exercise and adds only its declared roots [A1,C7,#9675]', { concurrency: true }, async (t) => {
  assert.ok(catalogGroups['results-a1'].length > 0, 'the group holds cases');
  // Every private scenario finishes before the group's verdict.
  const completed = await Promise.allSettled(catalogGroups['results-a1'].map(({ name, run }) => t.test(name, run)));
  for (const result of completed) if (result.status === 'rejected') throw result.reason;
});
