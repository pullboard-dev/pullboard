/** A claim of an after-gate dependent records one note on it naming the parent, its head and the claim time; a verified parent records the minutes saved and a send-back a rebuild [C7,#12325,#12326]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSubmitHandoff } from "../../../../../jobs/index.js";
import { setAfterGate } from "../../../../src/io/board/item/after-gate.js";
import { getItem } from "../../../../index.js";
import { itemThread } from "../../../../index.js";
import { fixture } from "../../../fixtures/dispatch.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as store from "../../../../index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { afterGateReport } from "../../../../index.js";
import { recordAfterGateClaim } from "../../../../src/io/board/item/after-gate-report.js";
import { recordAfterGateRebuild } from "../../../../src/io/board/item/after-gate-report.js";
import { cellBoard } from "../../../fixtures/cell.js";
import { cellItem } from "../../../fixtures/cell.js";
import { cellSeat } from "../../../fixtures/cell.js";
import { temporaryRepository } from "../../../fixtures/submit.js";

/** The after-gate claim notes on one item's thread. */
function claimNotes(board, id) {
  return itemThread(board, id).filter(entry => entry.type === "fact" && entry.kind === "note" && String(entry.text).startsWith("after-gate claim:"));
}

/** A board with a gate-green parent submitted at a real head, and the seat that claims. */
function seeded(t) {
  const box = fixture(t);
  const parent = box.add("Green parent");
  box.submit(parent);
  const head = getItem(box.board, parent).item_commit;
  recordSubmitHandoff(box.board.db, parent, { id: `fixture-${parent}`, commit: head, agentId: box.seats.builder.id, state: "green" });
  return { box, parent, head };
}

test("store.io-board-item-after-gate-report.claim-recorded: clause 1: claiming a dependent whose after-gate parent is gate-green records one note fact starting after-gate claim: naming the parent id, the parent head and the claim time, and a plain --after claim and a renewed claim record none [C7,#12325]", t => {
  const { box, parent, head } = seeded(t);
  const child = box.add("Dependent on the gate");
  setAfterGate(box.board, child, [parent]);
  box.claim(child);
  const notes = claimNotes(box.board, child);
  assert.equal(notes.length, 1, "one note for the claim");
  assert.ok(notes[0].text.includes(`#${parent}`), "names the parent id");
  assert.ok(notes[0].text.includes(head), "names the parent head");
  assert.ok(notes[0].text.includes(box.clock.now().toISOString()), "names the claim time");
  box.claim(child);
  assert.equal(claimNotes(box.board, child).length, 1, "a renewed claim records none");
  const plain = box.add("Item with no after-gate parent");
  box.claim(plain, box.seats.actor);
  assert.equal(claimNotes(box.board, plain).length, 0, "a claim with no after-gate parent records none");
});

const COMMIT = "a".repeat(40);
const TRUNK = "b".repeat(40);
const CLAUSE = "the fixture keeps its behavior";
const POLICY = { version: 1, commit: COMMIT, verify: { policy: "any", family: "off" } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: "synthetic board-state fixture; no gate execution" };

/** A real board file on a controllable clock, with a builder, two dependent builders and a reviewer. */
function timed(t) {
  const repo = temporaryRepository(t, "pullboard-after-gate-report-");
  mkdirSync(join(repo, ".git", "pullboard"));
  const clock = { at: Date.parse("2026-11-20T10:00:00.000Z"), now: () => new Date(clock.at) };
  const board = cellBoard(t, join(repo, ".git", "pullboard", "board.sqlite"), clock, { real: true, gitRoot: repo });
  cellSeat(board, { lane: "coordinator", path: "/repo" });
  const seat = (name, lane, route) => cellSeat(board, { lane, path: `/${name}`, family: `${name} Vendor`, route });
  const seats = { builder: seat("builder", "core", "mid"), first: seat("first", "core", "mid"), second: seat("second", "core", "mid"), third: seat("third", "core", "mid"), reviewer: seat("reviewer", "review", "strong") };
  const item = title => cellItem(board, { lane: "core", title, criterion: CLAUSE, route: "mid", check: "true", brief: "Files: src/a.js\nTest: proves it" }).item_id;
  const claim = (id, seat) => store.claim(board, id, { agentId: seat.id, lane: "core", leaseMs: 7_200_000, freeze: row => ({ text: JSON.stringify({ criterion: row.item_criterion, policy: POLICY }), digest: `digest:${id}` }) });
  const submitted = title => {
    const id = item(title);
    claim(id, seats.builder);
    store.writeBoardCommand(board, "submit", [id, { agentId: seats.builder.id, commit: COMMIT, tree: COMMIT, submissionProof: PROOF }], seats.builder.id);
    return id;
  };
  const verdict = (id, decision) => {
    board.executionEngineVersion = ENGINE_VERSION;
    const row = store.getItem(board, id);
    return store.verify(board, id, { agentId: seats.reviewer.id, decision, head: row.item_commit, digest: row.item_frozen_digest, policy: "any", familyPolicy: "off",
      ...(decision === "REJECT" ? { reason: "TEST_FAILURE", clause: CLAUSE } : {}), note: "Synthetic fixture verdict: read the diff against the bar.",
      review: { commit: row.item_commit, head: row.item_commit, trunk: TRUNK, paths: [] } });
  };
  return { board, clock, seats, item, claim, submitted, verdict };
}

/** The note texts on one item that start with a prefix. */
const notesStarting = (board, id, prefix) => itemThread(board, id).filter(entry => entry.type === "fact" && entry.kind === "note" && String(entry.text).startsWith(prefix)).map(entry => entry.text);

test("store.io-board-item-after-gate-report.verify-and-rebuild-recorded: clause 1: verifying an after-gate parent records one after-gate saved: note naming each claimed dependent and its whole minutes, and sending a dependent back records one after-gate rebuild: note naming it on the parent [C7,#12326]", t => {
  const { board, clock, seats, item, claim, submitted, verdict } = timed(t);
  // Both parents are submitted before the first verdict sets the engine that seals each submission's policy.
  const parent = submitted("Parent that is verified");
  const rejected = submitted("Parent that is rejected");
  const rebuilt = item("Dependent that is rebuilt");
  claim(rebuilt, seats.third);
  setAfterGate(board, rebuilt, [rejected]);
  const first = item("First dependent"), second = item("Second dependent"), idle = item("Dependent that never claimed");
  claim(first, seats.first);
  recordAfterGateClaim(board, first, { parent, head: COMMIT, agentId: seats.first.id });
  clock.at += 450_000;
  claim(second, seats.second);
  recordAfterGateClaim(board, second, { parent, head: COMMIT, agentId: seats.second.id });
  for (const id of [first, second, idle]) setAfterGate(board, id, [parent]);
  clock.at += 300_000;
  verdict(parent, "ACCEPT");
  const saved = notesStarting(board, parent, "after-gate saved:");
  assert.equal(saved.length, 1, "one saved note on the parent");
  assert.ok(saved[0].includes(`#${first} 12 min`), "the first dependent's whole minutes: 12 min 30 s floors to 12");
  assert.ok(saved[0].includes(`#${second} 5 min`), "the second dependent's whole minutes");
  assert.ok(!saved[0].includes(`#${idle}`), "a dependent that never claimed on the gate is not named");

  verdict(rejected, "REJECT");
  const rebuilds = notesStarting(board, rejected, "after-gate rebuild:");
  assert.equal(rebuilds.length, 1, "one rebuild note on the parent");
  assert.ok(rebuilds[0].includes(`#${rebuilt}`), "it names the dependent sent back");
  assert.equal(notesStarting(board, parent, "after-gate rebuild:").length, 0, "a verified parent records no rebuild");
});

test("store.io-board-item-after-gate-report.report-reads-back: clause 1: afterGateReport sums the minutes of every saved note and counts the rebuild notes on a parent, and reads zero for a parent with none [C7,#12327]", t => {
  const { box, parent } = seeded(t);
  const agentId = box.seats.builder.id;
  assert.deepEqual(afterGateReport(box.board, parent), { savedMinutes: 0, rebuilds: 0 });
  store.appendFact(box.board, parent, { agentId, kind: "note", text: "after-gate saved: #11 12 min, #12 5 min" });
  store.appendFact(box.board, parent, { agentId, kind: "note", text: "after-gate saved: #13 3 min" });
  recordAfterGateRebuild(box.board, parent, 14, { agentId });
  recordAfterGateRebuild(box.board, parent, 15, { agentId });
  store.appendFact(box.board, parent, { agentId, kind: "note", text: "an unrelated note: 99 min" });
  assert.deepEqual(afterGateReport(box.board, parent), { savedMinutes: 20, rebuilds: 2 });
  const plain = box.add("Parent with no after-gate notes");
  assert.deepEqual(afterGateReport(box.board, plain), { savedMinutes: 0, rebuilds: 0 });
});
