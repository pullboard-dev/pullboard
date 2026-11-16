import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 12 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '90', '--only', 'apps/cli/journeys/fact/msg.test.js'], { stdio: 'inherit' });
  console.log('JCOUT fact/msg', r.status);
});
