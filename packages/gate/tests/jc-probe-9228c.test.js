import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/queue/team/freshness.test.js,apps/cli/journeys/queue/team/policy.test.js,apps/cli/journeys/relay/cause.test.js,apps/cli/journeys/relay/checkpoint/inputs.test.js'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.split('\n')) if (/^(# )?(hold|unmeasured|convert|\d+ of)/.test(l.trim())) console.log('JCV ' + l);
});
