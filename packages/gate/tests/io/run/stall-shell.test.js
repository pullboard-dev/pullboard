/** A local gate run through runShellAsync with no hard timeout and no progress for the stall interval ends stalled and frees its slot [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShellAsync } from '../../../src/io/run/shell.js';
import { runStallMs } from '../../../src/io/run/stall.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** The stall interval these tests use: short, so a hung command is measured in seconds. */
const STALL_MS = 1_500;

test('clause 1: a command with no output, CPU or process change for the stall interval ends red, named stalled, with its processes gone [C7]', async () => {
  const { root } = privateFixtureFiles('pullboard-stall-shell-');
  const run = await runShellAsync(root, 'echo started; sleep 600', { stallMs: STALL_MS });
  assert.equal(run.isGreen, false, 'a stall is never a pass');
  assert.match(run.output, /PULLBOARD_RUN_STALLED: no output and no CPU or process change for \d+s/u);
  assert.match(run.output, /sleep 600/u, 'the stalled process is named');
  assert.ok(run.seconds < 120, 'the run ended long before the sleep would have, so its slot is free');
});

test('clause 1: a command that keeps printing is never a stall [C7]', async () => {
  const { root } = privateFixtureFiles('pullboard-stall-shell-');
  const run = await runShellAsync(root, 'for n in 1 2 3 4 5 6 7 8; do echo tick $n; sleep 0.5; done', { stallMs: STALL_MS });
  assert.equal(run.isGreen, true);
  assert.doesNotMatch(run.output, /PULLBOARD_RUN_STALLED/u);
});

test('clause 1: the stall interval is 15 minutes by default, 0 turns it off and a malformed value is refused [C7]', () => {
  assert.equal(runStallMs(undefined), 900_000);
  assert.equal(runStallMs('0'), 0);
  assert.throws(() => runStallMs('soon'), /PULLBOARD_RUN_STALL_MS must be 0/u);
});
