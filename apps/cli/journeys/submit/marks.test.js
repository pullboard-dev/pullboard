/** With submit.clauseMarks on, a submit records each bar clause with its tick state on the item and show lists them; off, it records nothing extra (#9440) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inProcess } from '../../tests/fixtures/submit/fail.js';
import { project } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';

/** A project whose one-clause item is ticked or not, submitted with the setting on or off; returns what `show` prints afterwards. */
async function shownAfterSubmit(t, { on, ticked }) {
  const { box } = await project(t, { extra: { submit: { requireInfraNote: false, autoFileMainReds: false } } });
  if (on) fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { submit: { clauseMarks: true } });
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): change a [G1]');
  if (ticked) assert.equal((await inProcess(box, box.root, 'fact', '1', 'note', 'clause 1 [reasoning]: the change is the whole bar, see src/a.js')).code, 0);
  const queued = box.run('submit', '1', '--json', '--no-next', '--infra', 'the clause marks fixture');
  assert.equal(queued.code, 0, JSON.stringify(queued));
  return (await inProcess(box, box.root, 'show', '1')).out;
}

test('clause 1: with submit.clauseMarks on, a submit records the clause marks with the evidence each tick cites and show lists them [C7,#9440]', async t => {
  const shown = await shownAfterSubmit(t, { on: true, ticked: true });
  assert.match(shown, /Submit clause marks at [0-9a-f]{12}: 1 of 1 met\. 1 met \(the change is the whole bar, see src\/a\.js\)\./u);
});

test('clause 1: with submit.clauseMarks on, a clause no tick covers is recorded as not marked [C7,#9440]', async t => {
  const shown = await shownAfterSubmit(t, { on: true, ticked: false });
  assert.match(shown, /Submit clause marks at [0-9a-f]{12}: 0 of 1 met\. 1 not marked\./u);
});

test('clause 2: with submit.clauseMarks unset, the default, a submit records no clause marks [C7,#9440]', async t => {
  const shown = await shownAfterSubmit(t, { on: false, ticked: true });
  assert.doesNotMatch(shown, /clause marks/iu);
});
