/** @pullboard-test-input apps/cli/src/io/commands/flow.js apps/cli/tests/fixtures/e2e.js */
/** pullboard flow tune prints the cycle clock and the chooser result from the board windows, read-only [C7,#1099]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.flow-tune.json-prints-cycle-and-choice: clause 1: pullboard flow tune --json on a seeded board prints the cycle state and the chooser result, and changes no setting [C7,#1099]', async () => {
  const box = e2e.project();
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Seed the board', criterion: 'the page exists', check: 'test -f web/page.js', run: box.runLocal });
  const before = await box.runLocal(box.repo, 'settings', '--json');
  assert.equal(before.code, 0, before.err || before.out);
  const tuned = await box.runLocal(box.repo, 'flow', 'tune', '--json');
  assert.equal(tuned.code, 0, tuned.err || tuned.out);
  const result = JSON.parse(tuned.out);
  assert.equal(result.version, 1);
  assert.equal(result.cycle.due, false, 'a seeded board with no landings is not due');
  assert.equal(typeof result.cycle.reason, 'string');
  assert.equal(result.choice.kind, 'none', 'no repeated constraint, so the chooser names no change');
  const after = await box.runLocal(box.repo, 'settings', '--json');
  assert.equal(after.out, before.out, 'flow tune applies nothing');
  const text = await box.runLocal(box.repo, 'flow', 'tune');
  assert.equal(text.code, 0, text.err || text.out);
  assert.match(text.out, /flow tune: not due/u);
  assert.match(text.out, /choice: none; no setting changed/u);
});
