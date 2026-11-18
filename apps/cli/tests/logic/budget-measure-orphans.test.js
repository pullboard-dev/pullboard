/** The waits size measurement counts only the fixture's own rows, never another run's orphan process [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutOrphanRows } from '../fixtures/budget-measure.js';

const TABLE = [
  'ok    pool                 3m / 10m    repo (pid 11)',
  'OVER  orphan              5h / 1m     pid 99 tests.js (pid 99)',
  '        doing: node test.js',
  '        parent gone (ppid 1)',
  'ok    orphan              1m / 1m     pid 98 other.js (pid 98)',
  '        parent gone (ppid 1)',
  'ok    job                 1m / 9m     gate (pid 12)',
  '3 waits; 1 over budget',
].join('\n');

test('cli.logic-budget-measure-orphans.the-waits-measurement-ignores-a-tmp-pullboard: clause 1: the waits measurement ignores a /tmp/pullboard-* orphan process the fixture did not start [C7]', () => {
  const kept = withoutOrphanRows(TABLE);
  assert.doesNotMatch(kept, /orphan|pid 99|pid 98|parent gone/u);
  assert.match(kept, /pool/u);
  assert.match(kept, /job/u);
  assert.match(kept, /^1 waits; 0 over budget$/mu, 'the summary is recounted for the rows left');
  const withNone = 'ok    pool                 3m / 10m    repo (pid 11)\n1 waits; 0 over budget';
  assert.equal(withoutOrphanRows(withNone), withNone, 'a table with no orphans is unchanged');
});
