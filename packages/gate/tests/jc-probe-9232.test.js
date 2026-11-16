import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/shout/http.test.js,apps/cli/journeys/show/policy/owner.test.js,apps/cli/journeys/skills/main.test.js,apps/cli/journeys/spec/changes.test.js'], { encoding: 'utf8', stdio: 'inherit' });
});
