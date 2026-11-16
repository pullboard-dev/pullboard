import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--only', 'apps/cli/journeys/agents/review.test.js,apps/cli/journeys/bar/check.test.js,apps/cli/journeys/bar/dry-run-review.test.js,apps/cli/journeys/budget/commands.test.js,apps/cli/journeys/budget/latency.test.js,apps/cli/journeys/cells/against.test.js,apps/cli/journeys/cells/drift.test.js,apps/cli/journeys/claim/checkpoint.test.js,apps/cli/journeys/claim/lease.test.js,apps/cli/journeys/decisions/row.test.js,apps/cli/journeys/doctrine/name.test.js,apps/cli/journeys/doctrine/name.verifier.test.js'], { encoding: 'utf8' });
  console.log('JCOUT', r.status, r.stdout, r.stderr.slice(-3000));
});
