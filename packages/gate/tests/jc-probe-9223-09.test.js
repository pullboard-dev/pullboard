import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 09 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '150', '--only', 'apps/cli/journeys/fact/checks-staged.test.js'], { stdio: 'inherit' });
  console.log('JCOUT fact/checks-staged', r.status);
});
