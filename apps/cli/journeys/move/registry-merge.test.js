/** @pullboard-test-input apps/cli/tests/fixtures/move/registry/** packages/state/data/history/** packages/state/src/logic/engines/** packages/moves/src/** */
/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js */
/** Two independent move items merge from one main without a snapshot conflict [C7,V4]. */
import { test } from 'node:test';
import { registryMergeProof } from '../../tests/fixtures/move/registry/cases.js';

test('two move items from one main merge without a snapshot conflict [C7,V4]', async () => {
  await registryMergeProof();
});
