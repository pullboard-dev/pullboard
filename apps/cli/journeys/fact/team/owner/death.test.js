/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  landingQueueCase,
  test,
} from '../../../../tests/fixtures/scenarios/team.js';

test('an abandoned landing drains its blocked gate before adoption [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private CLI death, owned-process cleanup, interrupted-batch adoption and Git; no speed target.
  async t => landingQueueCase(t, helpers, { killParent: true }));

test('a dead landing guardian cannot leave its blocked worker running [Q1,Q3,B3]', { timeout: 120_000 }, // budget: private guardian death, identity-bound cleanup and explicit adoption; no speed target.
  async t => landingQueueCase(t, helpers, { killGuardian: true }));
