import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/speed/spawns-submit-revs.test.js,apps/cli/journeys/speed/spawns-submit-status.test.js,apps/cli/journeys/stats/cost.test.js,apps/cli/journeys/stats/log.test.js'], { encoding: 'utf8' });
  const out = String(r.stdout) + String(r.stderr);
  console.log(out.split('\n').filter(l => /^(# )?(hold|unmeasured|convert|\d+ of)/.test(l)).join('\n'));
  console.log('JCOUT', r.status);
});
