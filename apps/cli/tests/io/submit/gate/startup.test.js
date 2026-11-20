/** @pullboard-test-input source-cell apps/cli */
/** The trusted analysis entry records its own start-up time as steps.startup in its result, proved from the entry text in this process [C7,#10574]. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ANALYSIS_ENTRY } from "../../../../src/io/submit/gate.js";

const LINES = ANALYSIS_ENTRY.split("\n");
const STARTUP = "const startup = Math.round(performance.now());";

test("cli.io-submit-gate-startup.the-result-carries-steps-startup-as-a: clause 1: the startup statement comes after the entry\x27s last import line and before its first await [C7]", () => {
  const at = LINES.map((line, index) => (line.trim() === STARTUP ? index : -1)).filter(index => index >= 0);
  assert.equal(at.length, 1, "exactly one startup statement");
  const lastImport = Math.max(...LINES.map((line, index) => (/^import\s/u.test(line) ? index : -1)));
  const firstAwait = LINES.findIndex(line => /\bawait\b/u.test(line.replace(/^\s*\/\/.*$/u, "")));
  assert.ok(lastImport >= 0 && firstAwait >= 0);
  assert.ok(lastImport < at[0], "after the last import line");
  assert.ok(at[0] < firstAwait, "before the first await");
});

test("cli.io-submit-gate-startup.every-other-key-is-unchanged-and-startup: clause 2: the result object the entry builds carries steps: { startup } beside main, source and notes, no other key [C7]", () => {
  const line = LINES.find(row => /\bresult = \{/u.test(row));
  assert.ok(line, "the entry builds a result object");
  const literal = line.slice(line.indexOf("result = {") + "result = ".length);
  const keys = [...literal.replace(/\{ startup \}/u, "STEPS").matchAll(/(?:^|[{,]\s*)(\w+):/gu)].map(match => match[1]);
  assert.deepEqual(keys, ["main", "source", "steps", "notes"]);
  assert.match(literal, /steps: \{ startup \}/u);
});
