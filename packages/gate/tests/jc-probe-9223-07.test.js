import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 07 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '90', '--only', 'apps/cli/journeys/engine/settings.test.js'], { stdio: 'inherit' });
  console.log('JCOUT engine/settings', r.status);
});
