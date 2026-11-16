/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js packages/store/src/io/exchange.js packages/person/src/io/signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: the no-culprit trunk hold case, split from host.test.js so each file fits its budget. */
import {
  assertNoCulpritTrunkHold,
  helpers,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('a no-culprit red files a defect and the waiver releases it [E27,E28,E29]', { timeout: 180_000, skip: 'CONTROLLER_ONLY: deleted with #6579' }, () => { // budget: hang ceiling for real Git/CLI landings, bisection and waiver controls; no speed target.
  assertNoCulpritTrunkHold(helpers);
});
