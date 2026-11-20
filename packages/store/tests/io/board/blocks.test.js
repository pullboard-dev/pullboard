/** addBlock records a named block of items in the store and listBlocks reads it back [C7,#2202]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addBlock } from "../../../index.js";
import { listBlocks } from "../../../index.js";
import { addItem } from "../../../index.js";
import { BLOCK_ENGINE } from "../../../../state/light.js";
import { cellBoard } from "../../fixtures/cell.js";
import { cellProject } from "../../fixtures/cell.js";
import { cellSeat } from "../../fixtures/cell.js";

const BRIEF = "Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n";

/** A board with a coordinator seat and two open items; returns the board and the two ids. */
function twoItems(t) {
  const project = cellProject(t, { real: true, gate: "true" });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: "coordinator", path: project.repo });
  const add = title => addItem(board, { by: "coordinator", lane: "web", title, route: "mid", criterion: "The private fixture proves the block.", brief: BRIEF, check: "true" });
  return { board, ids: [add("First member"), add("Second member")] };
}

test("store.blocks.add-and-list: clause 1: addBlock on a board with two open items stores the newBlock record and listBlocks returns it with its members [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  assert.deepEqual(listBlocks(board), []);
  const added = addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "mid" });
  assert.equal(added.name, "pair");
  const listed = listBlocks(board);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "pair");
  assert.equal(listed[0].tier, "mid");
  assert.deepEqual(listed[0].ids, ids);
  assert.deepEqual(listed[0].members, ids);
  assert.equal(listed[0].by, "coordinator");
});

test("store.blocks.refusals: clause 2: a repeated name refuses BLOCK_EXISTS, an unknown member id refuses NO_ITEM, and a board below BLOCK_ENGINE refuses ENGINE_VERSION [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "light" });
  assert.throws(() => addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "light" }), { code: "BLOCK_EXISTS" });
  assert.throws(() => addBlock(board, { agentId: "coordinator", name: "ghost", ids: [ids[0], 999999], tier: "light" }), { code: "NO_ITEM" });
  assert.equal(listBlocks(board).length, 1, "the refused writes recorded nothing");
  board.executionEngineVersion = BLOCK_ENGINE - 1;
  assert.throws(() => addBlock(board, { agentId: "coordinator", name: "older", ids, tier: "light" }), { code: "ENGINE_VERSION" });
});

test("store.blocks.real-path: clause 3: addBlock called through the store front door records a block that listBlocks reads and a usage refusal records nothing [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  assert.equal(typeof addBlock, "function");
  assert.throws(() => addBlock(board, { agentId: "coordinator", name: "solo", ids: [ids[0]], tier: "mid" }), { code: "USAGE" });
  addBlock(board, { agentId: "coordinator", name: "front-door", ids, tier: "strong" });
  assert.deepEqual(listBlocks(board).map(block => block.name), ["front-door"]);
});
