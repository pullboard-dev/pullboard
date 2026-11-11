/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../../tests/fixtures/scenarios/team.js';

test('clause 1: a suspended landing owner is fenced before the queued adopter runs [Q1,Q3]', { timeout: 170_000 }, // budget: queue authority aged for the adopter, then the stopped owner's own deadline before its fencing on resume; no speed target.
  async t => landingQueueCase(t, helpers, { suspendParent: true }));
