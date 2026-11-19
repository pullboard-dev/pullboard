/** The register descriptor floors the engine by the seat role it records and says how to fix a bad role [C7,H16]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVISOR_ROLE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { NEEDS_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { MOVE_REGISTRY } from "../../../index.js";

const floor = (...args) => MOVE_REGISTRY.register.minimumEngine(args, null);

test("moves.logic-moves-register.clause-1-a-role-raises-the-floor: clause 1: a register carrying a role is floored at ADVISOR_ROLE_ENGINE and one carrying none keeps its old floor [C7,H16]", () => {
  assert.ok(floor({ role: "advisor" }, {}) >= ADVISOR_ROLE_ENGINE);
  assert.equal(floor({}, {}), 1);
  assert.equal(floor({}, { cause: "conflict: x" }), RIGOR_AUTO_ENGINE);
  assert.equal(floor({ landingFence: 1 }, {}), LANDING_LEASE_ENGINE);
  assert.equal(floor({}, { cause: "sentinel: x" }), BOARD_SENTINEL_ENGINE);
});

test("moves.logic-moves-register.clause-2-bad-role-reason: clause 2: the BAD_ROLE refusal says use --role advisor, or leave --role off for an ordinary seat [C7,H16]", () => {
  assert.equal(MOVE_REGISTRY.register.nextSteps.BAD_ROLE, "use --role advisor, or leave --role off for an ordinary seat");
});

test("moves.register.abilities-floor: clause 1: a register carrying abilities is floored at NEEDS_ENGINE and one carrying none keeps its old floor [C7,#1888]", () => {
  assert.ok(floor({ abilities: ["browser"] }, {}) >= NEEDS_ENGINE);
  assert.equal(floor({}, {}), 1);
  assert.equal(floor({ role: "advisor" }, {}), ADVISOR_ROLE_ENGINE);
  assert.equal(floor({ landingFence: 1 }, {}), LANDING_LEASE_ENGINE);
});
