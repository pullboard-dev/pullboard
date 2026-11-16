import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/spec/e2e/submit.test.js,apps/cli/journeys/spec/main/gates.test.js,apps/cli/journeys/spec/revise.test.js,apps/cli/journeys/speed/profile.test.js'], { encoding: 'utf8', stdio: 'inherit' });
});
