/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: the held trunk's committed correction, split from trunk-hold.test.js so each file fits its budget. */
import {
  assertTrunkHoldCorrection,
  helpers,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('a committed correction to a held test releases the trunk without a waiver [E27,E28,E29]', { timeout: 180_000, skip: 'CONTROLLER_ONLY: deleted with #6579' }, () => { // budget: hang ceiling for real Git/CLI landings, bisection and waiver controls; no speed target.
  assertTrunkHoldCorrection(helpers);
});
