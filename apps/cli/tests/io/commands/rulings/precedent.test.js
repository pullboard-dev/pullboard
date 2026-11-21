/** pullboard rulings <key> prints every answer recorded under that cause, and refuses any other key with the valid ones [C7,#1444,#10980]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createE2eHelpers } from "../../../fixtures/e2e.js";
import { workHelp } from "../../../../src/logic/help/work.js";
import { COMMANDS } from "../../../../src/io/commands/index.js";
import { TYPED_REQUEST_CAUSES } from "../../../../../../packages/store/index.js";

/** Ask one decision of the person on a fixture project and return the project box and the decision id. */
async function ask(box, question) {
  const asked = await box.runLocal(box.repo, "shout", "person", question, "--decision", "--json");
  assert.equal(asked.code, 0, `${asked.err}\n${asked.out}`);
  return JSON.parse(asked.out).id;
}

test("cli.journeys-rulings-precedent.lists-each-answer-under-the-cause: clause 1: pullboard rulings design-choice exits 0 and lists each answer recorded with that cause with its shout id and text, and none recorded with another cause [C7,#1444,#10980]", async (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project();
  const answered = [];
  for (const [question, text, cause] of [["Which interface first?", "Share the interface", "design-choice"], ["Which tool broke?", "Tool is at fault", "tool-defect"], ["Which interface second?", "Keep it local", "design-choice"]]) {
    const id = await ask(box, question);
    const result = await box.runLocal(box.repo, "answer", String(id), text, "--as", "person", "--cause", cause);
    assert.equal(result.code, 0, `${result.err}\n${result.out}`);
    answered.push({ text, cause });
  }
  const result = await box.runLocal(box.repo, "rulings", "design-choice", "--json");
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const { rulings } = JSON.parse(result.out);
  assert.deepEqual(rulings.map((ruling) => ruling.text), ["Keep it local", "Share the interface"]);
  assert.ok(rulings.every((ruling) => Number.isInteger(ruling.shout)), "each ruling carries its shout id");
  const printed = await box.runLocal(box.repo, "rulings", "design-choice");
  assert.equal(printed.code, 0, `${printed.err}\n${printed.out}`);
  for (const ruling of rulings) {
    assert.ok(printed.out.includes(`#${ruling.shout}`), `the listing names #${ruling.shout}`);
    assert.ok(printed.out.includes(ruling.text), `the listing prints "${ruling.text}"`);
  }
  assert.ok(!printed.out.includes("Tool is at fault"), "an answer under another cause is not listed");
});

test("cli.journeys-rulings-precedent.a-cause-outside-the-list-is-refused: clause 2: pullboard rulings not-a-key exits non-zero with RULING_CAUSE naming the valid keys [C7,#1444,#10980]", async (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project();
  const result = await box.runLocal(box.repo, "rulings", "not-a-key");
  assert.notEqual(result.code, 0, "an unknown cause is refused");
  assert.match(result.err + result.out, /RULING_CAUSE/u);
  for (const key of TYPED_REQUEST_CAUSES) assert.ok((result.err + result.out).includes(key), `the refusal names ${key}`);
});

test("cli.journeys-rulings-precedent.the-command-is-registered-with-a-usage-line: clause 3: rulings.js is a registered command and the work help has its usage line [C7,#1444,#10980]", () => {
  assert.equal(typeof COMMANDS.rulings, "function", "rulings is discovered in commands/index.js");
  assert.match(workHelp, /pullboard rulings <cause>/u);
});
