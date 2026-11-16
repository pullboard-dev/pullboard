import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('probe [C7]', () => {
  const r = spawnSync('node', ['apps/cli/src/io/mutate/journey-check.js', '--only', 'apps/cli/journeys/runner/runners/setup.test.js,apps/cli/journeys/runner/stats-cost.test.js,apps/cli/journeys/settings/checkpoints.test.js,apps/cli/journeys/settings/seat-launch-profile.test.js,apps/cli/journeys/shout/http.test.js,apps/cli/journeys/show/policy/owner.test.js,apps/cli/journeys/skills/main.test.js,apps/cli/journeys/spec/changes.test.js,apps/cli/journeys/spec/e2e/submit.test.js,apps/cli/journeys/spec/main/gates.test.js,apps/cli/journeys/spec/revise.test.js,apps/cli/journeys/speed/profile.test.js.'], { encoding: 'utf8' });
  console.log('JCOUT', r.status, r.stdout, r.stderr.slice(-3000));
});
