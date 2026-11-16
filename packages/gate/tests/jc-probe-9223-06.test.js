import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 06 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '90', '--only', 'apps/cli/journeys/engine/merged.test.js'], { stdio: 'inherit' });
  console.log('JCOUT engine/merged', r.status);
});
