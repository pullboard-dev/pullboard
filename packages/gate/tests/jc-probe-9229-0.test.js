/** Throwaway probe for #9229: runs the journey coverage check on four journeys [C7]. */
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('probe 0 [C7]', { timeout: 600000 }, () => {
  const run = spawnSync(process.execPath, ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', ['apps/cli/journeys/relay/client/claims.test.js', 'apps/cli/journeys/relay/client/claims/later.test.js', 'apps/cli/journeys/relay/client/claims/middle.test.js', 'apps/cli/journeys/relay/credential.test.js'].join(',')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter(line => /^(# )?(hold|unmeasured|convert|\d+ of)/u.test(line));
  process.stdout.write(`PROBE0 status=${run.status}\n${lines.join('\n')}\n`);
});
