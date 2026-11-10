/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assertMatchingLandingHost,
  assertNoCulpritTrunkHold,
  helpers,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('land runs on a matching host [E27,E28,E29]', { timeout: 180_000 }, () => { // budget: hang ceiling for real Git/CLI host checks, bisection and waiver controls; no speed target.
  assertMatchingLandingHost(helpers);
  assertNoCulpritTrunkHold(helpers);
});
