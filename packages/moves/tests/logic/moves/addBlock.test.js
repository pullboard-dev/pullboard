/** The addBlock descriptor routes at BLOCK_ENGINE and names the next step for a taken block name [C7]. */
// fixture-subject: addBlock (a descriptor unit test; no board is built)
import assert from "node:assert/strict";
import { test } from "node:test";
import addBlock from "../../../src/logic/moves/addBlock.js";
import { BLOCK_ENGINE } from "../../../../state/light.js";

test("moves.add-block.descriptor: clause 1: the addBlock descriptor names operation addBlock, reads its actor from args[0].agentId and its minimumEngine returns BLOCK_ENGINE [C7]", () => {
  assert.equal(addBlock.operation, "addBlock");
  assert.equal(addBlock.actor({ args: [{ agentId: "coordinator" }] }), "coordinator");
  assert.equal(addBlock.minimumEngine({ args: [] }), BLOCK_ENGINE);
});

test("moves.add-block.next-step: clause 2: nextSteps maps BLOCK_EXISTS to a step naming pullboard block add with another name [C7]", () => {
  assert.match(addBlock.nextSteps.BLOCK_EXISTS, /pullboard block add <another name>/u);
});
