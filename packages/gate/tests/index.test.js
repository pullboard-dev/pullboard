/** @pullboard-test-input source-cell packages/gate */
/** The gate front door exports the static-on-main helpers the trusted analysis entry calls [C7]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as door from "../index.js";
import { splitByMain } from "../src/logic/static/findings.js";
import { staticFindingsOnMain } from "../src/io/static/main-findings.js";

test('gate.index.split-by-main-is-the-modules-own: clause 1: splitByMain from the door is the findings module function [C7]', () => {
  assert.equal(door.splitByMain, splitByMain);
});

test('gate.index.static-findings-on-main-is-the-modules-own: clause 1: staticFindingsOnMain from the door is the main-findings module function [C7]', () => {
  assert.equal(door.staticFindingsOnMain, staticFindingsOnMain);
});
