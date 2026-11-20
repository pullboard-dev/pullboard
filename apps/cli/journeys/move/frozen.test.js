/** @pullboard-test-input apps/cli/tests/fixtures/move/registry/** packages/state/data/history/** packages/state/src/logic/engines/** packages/moves/src/** */
/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js */
/** Two independent move items merge from one main: shipped and legacy engine records stay frozen [C7,V4]. */
import { test } from 'node:test';
import { registryFrozenProof } from '../../tests/fixtures/move/registry/cases.js';

test('cli.journeys-move-frozen.the-registry-check-rejects-an-edited: clause 1: the registry check rejects an edited shipped or legacy engine record after two move items merge from one main [C7,V4]', async () => {
  await registryFrozenProof();
});
