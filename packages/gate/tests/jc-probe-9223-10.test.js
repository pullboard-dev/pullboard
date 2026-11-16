import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 10 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '150', '--only', 'apps/cli/journeys/fact/e2e/tour.test.js'], { stdio: 'inherit' });
  console.log('JCOUT fact/e2e/tour', r.status);
});
