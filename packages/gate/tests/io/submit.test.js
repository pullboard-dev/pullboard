/** @pullboard-test-loads packages/gate/src/io/submit.js */
/** The accepted main's affectedTests runner wins over an item's older policy, so an item pinned before a runner fix never proves under the old runner [C7,#11754]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { submitGateConfig } from "../../index.js";
import { submitGatePlan } from "../../index.js";
import { fixture } from "../../../landing/tests/fixtures/plan.js";
import { git } from "../../../landing/tests/fixtures/plan.js";

const ITEM = { gate: "g", affectedTests: "node --test", submitInvariants: [], registryGuards: [] };
const ACCEPTED = { gate: "g", submitGate: "", staticChecks: [], submitInvariants: [], submitDeferAbove: undefined, registryGuards: [], affectedTests: "npx jest" };

test("gate.io-submit.accepted-affected-tests-wins: clause 1: main's affectedTests wins when main has no invariants or guards [C7,#11754]", () => {
  assert.equal(submitGateConfig(ITEM, ACCEPTED).affectedTests, "npx jest");
});

test("gate.io-submit.blank-accepted-keeps-item-runner: clause 2: an unset or blank main affectedTests keeps the item's own runner [C7,#11754]", () => {
  const { affectedTests: _unset, ...unset } = ACCEPTED;
  assert.equal(submitGateConfig(ITEM, unset).affectedTests, "node --test");
  assert.equal(submitGateConfig(ITEM, { ...ACCEPTED, affectedTests: "  " }).affectedTests, "node --test");
});

test("gate.io-submit.plan-proof-uses-main-runner: clause 3: the submit plan's proof command starts with main's runner for an item whose own runner is older [C7,#11754]", t => {
  const { root, put } = fixture(t);
  put("test/other.test.js", "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "other");
  const base = git(root, "rev-parse", "HEAD").trim();
  put("test/changed.test.js", "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  const plan = submitGatePlan(root, submitGateConfig(ITEM, ACCEPTED), { base, changed: ["test/changed.test.js"] });
  assert.ok(plan.proofCommand.startsWith("npx jest"), `proof runs under main's runner: ${plan.proofCommand}`);
});
