/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../../tests/fixtures/scenarios/team.js';

test('an abandoned landing is reclaimed and its interrupted batch adopted only on request [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private CLI death, lease reclaim, interrupted-batch adoption and Git; no speed target.
  async t => landingQueueCase(t, helpers, { killParent: true }));

test('a landing whose blocked gate dies blocks its batch and leaves nothing to adopt [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private gate death and its blocked batch; no speed target.
  async t => landingQueueCase(t, helpers, { killGuardian: true }));
