import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', 'apps/cli/journeys/flow/replay.test.js,apps/cli/journeys/flow/replay/policy.test.js,apps/cli/journeys/gate/newcomer.test.js,apps/cli/journeys/handoff/dead/requeue.test.js'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.split('\n')) if (/^(# )?(hold|unmeasured|convert|\d+ of)/.test(l.trim())) console.log('JCV ' + l);
});
