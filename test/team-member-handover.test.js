/** @pullboard-test-loads src/board.js src/engine.js src/exchange.js src/person-signing.js apps/relay/src/shell/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  memberHandoverCase,
  test,
  withBoard,
} from './team-scenarios.fixture.js';

test('a non-approver device without a signed member list receives no board key [H15,E17]', async t => memberHandoverCase(t, { helpers, withBoard }));
