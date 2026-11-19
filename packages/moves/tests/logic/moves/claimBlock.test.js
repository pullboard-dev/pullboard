/** The claimBlock descriptor routes at BLOCK_ENGINE and names a next step for each refusal [C7]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_ENGINE } from "../../../../state/light.js";
import claimBlock from "../../../src/logic/moves/claimBlock.js";

test('moves.claim-block.descriptor: clause 1: claimBlock names its operation, reads its actor from args[0].agentId and routes at BLOCK_ENGINE [C7]', () => {
  assert.equal(claimBlock.operation, "claimBlock");
  assert.equal(claimBlock.actor({ args: [{ agentId: "web-1" }] }), "web-1");
  assert.equal(claimBlock.actor({ args: [] }), null);
  assert.equal(claimBlock.minimumEngine(), BLOCK_ENGINE);
});

test('moves.claim-block.next-steps: clause 2: NO_BLOCK, BLOCK_CLAIMED and BLOCK_TIER each map to a step naming pullboard block list or another seat [C7]', () => {
  for (const code of ["NO_BLOCK", "BLOCK_CLAIMED", "BLOCK_TIER"]) {
    assert.match(claimBlock.nextSteps[code], /pullboard block list|another (seat|block)/u, code);
  }
});
