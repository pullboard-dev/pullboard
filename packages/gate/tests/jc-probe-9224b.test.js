import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/fact/team/owner/fence.test.js,apps/cli/journeys/fact/team/trunk-hold-fix.test.js,apps/cli/journeys/fact/team/trunk-hold.test.js,apps/cli/journeys/fact/timing.test.js'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.split('\n')) if (/^(# )?(hold|unmeasured|convert|\d+ of)/.test(l.trim())) console.log('JCV ' + l);
});
