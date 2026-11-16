import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/next/builder-first.test.js,apps/cli/journeys/next/contention-setting.test.js,apps/cli/journeys/next/contention.test.js,apps/cli/journeys/next/exit-checkpoint.test.js'], { encoding: 'utf8', stdio: 'inherit' });
});
