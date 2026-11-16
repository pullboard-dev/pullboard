import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--only', 'apps/cli/journeys/init/seat-loop.test.js,apps/cli/journeys/init/worker-skill.test.js,apps/cli/journeys/intake/main.test.js,apps/cli/journeys/lane/add.test.js,apps/cli/journeys/lane/test.test.js,apps/cli/journeys/list/startup-version.test.js,apps/cli/journeys/mcp/main.test.js,apps/cli/journeys/move/registry.test.js,apps/cli/journeys/next/builder-first.test.js,apps/cli/journeys/next/contention-setting.test.js,apps/cli/journeys/next/contention.test.js,apps/cli/journeys/next/exit-checkpoint.test.js.'], { encoding: 'utf8' });
  console.log('JCOUT', r.status, r.stdout, r.stderr.slice(-3000));
});
