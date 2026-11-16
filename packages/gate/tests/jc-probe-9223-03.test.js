import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 03 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '60', '--only', 'apps/cli/journeys/doctrine/pulled-ratchets.test.js'], { stdio: 'inherit' });
  console.log('JCOUT doctrine/pulled-ratchets', r.status);
});
