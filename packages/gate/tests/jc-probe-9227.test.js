import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/init/seat-loop.test.js,apps/cli/journeys/intake/main.test.js,apps/cli/journeys/mcp/main.test.js,apps/cli/journeys/move/registry.test.js'], { encoding: 'utf8', stdio: 'inherit' });
});
