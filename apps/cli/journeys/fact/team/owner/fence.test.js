/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../../tests/fixtures/scenarios/team.js';

test('clause 1: a suspended landing owner is fenced before the queued adopter runs [Q1,Q3]', { timeout: 150_000 }, // budget: the stopped owner's aged authority, its fencing on resume and adoption; no speed target.
  async t => landingQueueCase(t, helpers, { suspendParent: true }));
