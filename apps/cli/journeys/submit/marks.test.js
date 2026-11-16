/** With submit.clauseMarks on, a submit records each bar clause with its tick state on the item and show lists them; off, it records nothing extra (#9440) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inProcess } from '../../tests/fixtures/submit/fail.js';
import { project } from '../../tests/fixtures/submit/fail.js';
import { clauseMarksNote } from '../../src/io/submit.js';
import { submitClauseMarks } from '../../../../packages/config/index.js';
import { settingsInventory } from '../../../../packages/config/index.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
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

test('clause 1: with submit.clauseMarks on, a clause no tick covers is recorded as not marked [C7,#9440]', () => {
  const item = { item_owner: 'build-1', item_criterion: '1. a [test]\n2. b [reasoning]' };
  const thread = [{ type: 'fact', kind: 'note', by: 'build-1', text: 'clause 2 [reasoning]: because' }];
  assert.equal(clauseMarksNote(item, thread, 'a'.repeat(40)), 'Submit clause marks at aaaaaaaaaaaa: 1 of 2 met. 1 not marked; 2 met (because).');
  assert.equal(clauseMarksNote({ ...item, item_criterion: '' }, thread, 'a'.repeat(40)), null);
});

test('clause 2: with submit.clauseMarks unset, the default, a submit records no clause marks [C7,#9440]', t => {
  const box = privateRepo(t);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  assert.equal(submitClauseMarks(), false, 'the submit path records marks only when this reads true');
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'submit.clauseMarks');
  assert.equal(row.default, false);
  assert.ok(row.label && row.description, 'the row carries a plain label and description');
});
