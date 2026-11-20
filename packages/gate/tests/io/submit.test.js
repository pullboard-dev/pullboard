/** @pullboard-test-loads packages/gate/src/io/submit.js */
/** The accepted main's affectedTests runner wins over an item's older policy, so an item pinned before a runner fix never proves under the old runner [C7,#11754]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitGateAdmission } from '../../src/io/submit.js';
import { privateFixtureFiles } from '../fixtures/child.js';
import { submitGateConfig } from "../../heavy.js";
import { submitGatePlan } from "../../heavy.js";
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

test('gate.io-submit.admission-item-needs: clause 1: submitGateAdmission returns browser true for options.needs [browser] and gui true for [gui] even when no check or proof file asks, and returns exactly the current admission when needs is absent or empty [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-admission-needs-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'plain.test.js'), "import { test } from 'node:test';\ntest('plain', () => {});\n");
  const files = ['test/plain.test.js'];
  const plan = { check: '', selection: { full: false, files }, deferFullFallback: false, deferSelection: false, proofFiles: files };
  const options = { allowBrowserFreeChecks: true };
  const current = await submitGateAdmission(root, plan, options);
  assert.deepEqual(current, { browser: false, gui: false }, 'nothing asks, so no slot is requested');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: [] }), current, 'an empty needs list changes nothing');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['browser'] }), { browser: true, gui: false }, 'a browser need asks for the browser slot');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['gui'] }), { browser: false, gui: true }, 'a gui need asks for the GUI slot');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['browser', 'gui'] }), { browser: true, gui: true }, 'both needs ask for both slots');
});
