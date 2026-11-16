import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--only', 'apps/cli/journeys/doctrine/name.verifier.test.js'], { encoding: 'utf8' });
  console.log('JCOUT', r.status, r.stdout, r.stderr.slice(-3000));
});
