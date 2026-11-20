/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  helpers,
  memberHandoverCase,
  test,
  withBoard,
} from '../../../fixtures/scenarios/team.js';

test('cli.journeys-fact-team-handover.a-non-approver-device-without-a: a non-approver device without a signed member list receives no board key [H15,E17]', async t => memberHandoverCase(t, { helpers, withBoard }));
