import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '420', '--only', 'apps/cli/journeys/next/builder-first.test.js,apps/cli/journeys/init/seat-loop.test.js,apps/cli/journeys/intake/main.test.js,apps/cli/journeys/mcp/main.test.js,apps/cli/journeys/move/registry.test.js'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  console.log('VERDICTS\n' + (r.stdout + r.stderr).split('\n').filter(l => /^# (hold|unmeasured|convert|\d+ of)/.test(l)).join('\n'));
});
