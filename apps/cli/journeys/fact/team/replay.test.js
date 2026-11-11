/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  rejectConsumedOffReplay,
  rejectFabricatedPasskeyMetadata,
  rejectSyntheticPasskeyEvent,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('person-only moves are signed against fabricated receipt metadata [E22,H16]', rejectFabricatedPasskeyMetadata);

test('person-only moves are signed against synthetic execution events [E22,H16]', rejectSyntheticPasskeyEvent);

test('person-only moves are signed against consumed OFF replay [E22,H16]', rejectConsumedOffReplay);
