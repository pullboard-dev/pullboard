/** addBlock records a named block of items in the store and listBlocks reads it back [C7,#2202]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addBlock } from "../../../index.js";
import { claim } from "../../../index.js";
import { claimBlock } from "../../../index.js";
import { getItem } from "../../../index.js";
import { listBlocks } from "../../../index.js";
import { addItem } from "../../../index.js";
import { BLOCK_ENGINE } from "../../../../state/light.js";
import { cellBoard } from "../../fixtures/cell.js";
import { cellProject } from "../../fixtures/cell.js";
import { cellSeat } from "../../fixtures/cell.js";

const BRIEF = "Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n";

const FREEZE = item => ({ text: item.item_title, digest: `digest:${item.item_title}` });
const HOUR = 60 * 60 * 1000;

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

test("store.blocks.claim-all-members: clause 1: claimBlock claims every open member for the seat in one write with the ordinary claim and one shared lease, and another seat claim of a member is refused [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "mid" });
  const seat = cellSeat(board, { lane: "web", path: "/block-seat", route: "strong" });
  const claimed = claimBlock(board, { agentId: seat.id, name: "pair", lane: "web", leaseMs: HOUR, freeze: FREEZE });
  assert.deepEqual(claimed.claimed, ids);
  const rows = ids.map(id => getItem(board, id));
  assert.deepEqual(rows.map(row => row.item_owner), [seat.id, seat.id]);
  assert.equal(rows[0].item_lease_until, rows[1].item_lease_until);
  assert.equal(rows[0].item_lease_until, claimed.leaseUntil);
  const events = board.db.prepare("SELECT event_kind FROM event WHERE event_kind = 'claim' AND event_by = ?").all(seat.id);
  assert.equal(events.length, 2, "each member has its own claim event");
  const rival = cellSeat(board, { lane: "web", path: "/block-rival", route: "strong" });
  assert.throws(() => claim(board, ids[0], { agentId: rival.id, lane: "web", leaseMs: HOUR, freeze: FREEZE }), { code: "HELD" });
});

test("store.blocks.claim-refusals: clause 2: an unknown name refuses NO_BLOCK, a member held by another seat refuses BLOCK_CLAIMED naming it with nothing claimed, and a seat whose route is below the block tier refuses BLOCK_TIER [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  const seat = cellSeat(board, { lane: "web", path: "/block-seat", route: "strong" });
  assert.throws(() => claimBlock(board, { agentId: seat.id, name: "ghost", lane: "web", leaseMs: HOUR, freeze: FREEZE }), { code: "NO_BLOCK" });
  addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "mid" });
  addBlock(board, { agentId: "coordinator", name: "heavy", ids, tier: "strong" });
  const light = cellSeat(board, { lane: "web", path: "/block-light", route: "light" });
  assert.throws(() => claimBlock(board, { agentId: light.id, name: "heavy", lane: "web", leaseMs: HOUR, freeze: FREEZE }), { code: "BLOCK_TIER" });
  const rival = cellSeat(board, { lane: "web", path: "/block-rival", route: "strong" });
  claim(board, ids[1], { agentId: rival.id, lane: "web", leaseMs: HOUR, freeze: FREEZE });
  assert.throws(() => claimBlock(board, { agentId: seat.id, name: "pair", lane: "web", leaseMs: HOUR, freeze: FREEZE }), error => error.code === "BLOCK_CLAIMED" && error.message.includes(`#${ids[1]}`));
  assert.equal(getItem(board, ids[0]).item_owner, null, "the refused block claimed no member");
});

test("store.blocks.renew-as-one: clause 1: renewing one member a seat holds through a block renews the lease of every member it holds through that block [C7,#2202]", t => {
  const { board, ids } = twoItems(t);
  addBlock(board, { agentId: "coordinator", name: "pair", ids, tier: "mid" });
  const seat = cellSeat(board, { lane: "web", path: "/block-seat", route: "strong" });
  claimBlock(board, { agentId: seat.id, name: "pair", lane: "web", leaseMs: HOUR, freeze: FREEZE });
  const before = getItem(board, ids[1]).item_lease_until;
  const renewed = claim(board, ids[0], { agentId: seat.id, lane: "web", leaseMs: 2 * HOUR, freeze: FREEZE });
  assert.equal(renewed.renewed, true);
  const rows = ids.map(id => getItem(board, id));
  assert.ok(rows[1].item_lease_until > before, "the second member's lease moved with the first's");
  assert.equal(rows[0].item_lease_until, rows[1].item_lease_until);
  assert.equal(rows[1].item_lease_until, renewed.leaseUntil);
  const events = board.db.prepare("SELECT item_id FROM event WHERE event_kind = 'renew' AND event_by = ?").all(seat.id).map(row => row.item_id).sort();
  assert.deepEqual(events, [...ids].sort(), "each member has its own renew event");
});
