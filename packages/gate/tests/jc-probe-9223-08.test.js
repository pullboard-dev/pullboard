import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe 08 [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '150', '--only', 'apps/cli/journeys/export/team/access.test.js'], { stdio: 'inherit' });
  console.log('JCOUT export/team/access', r.status);
});
