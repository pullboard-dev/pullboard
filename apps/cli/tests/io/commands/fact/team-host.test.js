/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assertMatchingLandingHost,
  helpers,
  test,
} from '../../../fixtures/scenarios/team.js';

test('cli.journeys-fact-team-host.land-runs-on-a-matching-host: land runs on a matching host [E27,E28,E29]', { timeout: 180_000 }, () => { // budget: hang ceiling for real Git/CLI host checks, host controls; no speed target.
  assertMatchingLandingHost(helpers);
});
