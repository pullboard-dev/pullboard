import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 02 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '150', '--only', 'apps/cli/journeys/doctrine/pulled-counts.test.js'], { stdio: 'inherit' });
  console.log('JCOUT doctrine/pulled-counts', r.status);
});
