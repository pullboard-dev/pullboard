/** @pullboard-test-input apps/cli/tests/fixtures/move/registry/** packages/state/data/history/** packages/state/src/logic/engines/** packages/moves/src/** */
/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js */
/** Two independent move items merge from one main: the landing allocation passes every registry oracle [C7,V4]. */
import { test } from 'node:test';
import { registryAllocationProof } from '../../../fixtures/move/registry/cases.js';

test('cli.journeys-move-allocation.the-allocated-merge-of-two-move-items: clause 1: the landing allocation of two move items merged from one main passes every registry oracle [C7,V4]', async () => {
  await registryAllocationProof();
});
