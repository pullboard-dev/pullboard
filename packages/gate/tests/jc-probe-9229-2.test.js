/** Throwaway probe for #9229: runs the journey coverage check on four journeys [C7]. */
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('probe 2 [C7]', { timeout: 600000 }, () => {
  const run = spawnSync(process.execPath, ['apps/cli/src/io/mutate/journey-check.js', '--budget', '400', '--only', ['apps/cli/journeys/relay/main.test.js', 'apps/cli/journeys/relay/outbox.test.js', 'apps/cli/journeys/relay/parity.test.js', 'apps/cli/journeys/relay/parity/clock.test.js'].join(',')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter(line => /^(# )?(hold|unmeasured|convert|\d+ of)/u.test(line));
  process.stdout.write(`PROBE2 status=${run.status}\n${lines.join('\n')}\n`);
});
