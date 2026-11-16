import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const files = 'apps/cli/journeys/doctrine/name.verify.test.js,apps/cli/journeys/doctrine/pulled-counts.test.js,apps/cli/journeys/doctrine/pulled-ratchets.test.js,apps/cli/journeys/doctrine/rulings.test.js,apps/cli/journeys/edges/door.test.js,apps/cli/journeys/engine/merged.test.js,apps/cli/journeys/engine/settings.test.js,apps/cli/journeys/export/team/access.test.js,apps/cli/journeys/fact/checks-staged.test.js,apps/cli/journeys/fact/e2e/tour.test.js,apps/cli/journeys/fact/family.test.js,apps/cli/journeys/fact/msg.test.js';
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--only', files], { stdio: 'inherit' });
  console.log('JCOUT', r.status);
});
