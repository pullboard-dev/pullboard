/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js relay/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assertMatchingLandingHost,
  assertNoCulpritTrunkHold,
  helpers,
  test,
} from './team-scenarios.fixture.js';

test('land runs on a matching host [E27,E28,E29]', { timeout: 180_000 }, () => { // budget: hang ceiling for real Git/CLI host checks, bisection and waiver controls; no speed target.
  assertMatchingLandingHost(helpers);
  assertNoCulpritTrunkHold(helpers);
});
