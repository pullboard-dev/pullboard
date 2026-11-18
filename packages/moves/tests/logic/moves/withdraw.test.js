/** The withdraw descriptor floors the engine by what the withdraw cites [C7,H16]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { MAIN_RED_WITHDRAW_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { WITHDRAW_AS_MET_ENGINE } from "../../../../state/light.js";
import { MOVE_REGISTRY } from "../../../index.js";

const floor = (...args) => MOVE_REGISTRY.withdraw.minimumEngine(args);

test("moves.logic-moves-withdraw.a-withdraw-citing-a-main-commit-is-floored: clause 1: minimumEngine returns at least WITHDRAW_AS_MET_ENGINE when the options carry a metCommit string [C7,H16]", () => {
  assert.ok(floor(7, { metCommit: "a".repeat(40) }) >= WITHDRAW_AS_MET_ENGINE);
});

test("moves.logic-moves-withdraw.the-existing-withdraw-floors-are-unchanged: clause 2: conflict, landingFence, sentinel, expected and a plain withdraw keep their floors [C7,H16]", () => {
  assert.equal(floor(7, { cause: "conflict: x" }), RIGOR_AUTO_ENGINE);
  assert.equal(MOVE_REGISTRY.withdraw.minimumEngine([{ landingFence: 1 }, {}]), LANDING_LEASE_ENGINE);
  assert.equal(floor(7, { cause: "sentinel: x" }), BOARD_SENTINEL_ENGINE);
  assert.equal(floor(7, { expected: { status: "open" } }), MAIN_RED_WITHDRAW_ENGINE);
  assert.equal(floor(7, {}), 1);
});
