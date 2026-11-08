/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  browserFreeRunnerCheck,
  browserRefusalTextStaysRed,
  cli,
  git,
  test,
} from './runners-scenarios.fixture.js';
import { browserRefusalRetriesRunner } from './runner-browser-free-fixture.js';
import { testsNeedBrowser } from '../packages/gate/index.js';
import assert from 'node:assert/strict';

test('clause 1: a browser-free check on a runner with no browser slots passes [C7]', { timeout: 180_000 }, t => browserFreeRunnerCheck(t, { cli, git })); // budget: two runner round trips and two local runs.
test('an authenticated browser refusal retries on a remote browser lease [C7]', { timeout: 180_000 }, t => browserRefusalRetriesRunner(t, { cli, git })); // budget: two remote runner round trips.
test('a fixture-child test without the browser declaration needs no browser [C7]', async () => {
  const files = ['test/precommit-lane-merged-main.test.js'];
  assert.equal(await testsNeedBrowser(process.cwd(), files), false);
});

test('clause 2: a test that prints the browser refusal text on a runner stays red and is not rerun, within its time limit [C7]', { timeout: 120_000 }, t => browserRefusalTextStaysRed(t, { cli, git })); // budget: one runner round trip.
