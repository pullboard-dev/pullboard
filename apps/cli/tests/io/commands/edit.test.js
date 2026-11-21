/** edit --check marks a new command's baseline strict behind claim.checkCeiling [C7,#1273]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { onBoard } from '../../fixtures/land/board.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import * as store from '../../../../../packages/store/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** An item filed with one check, then edited to a new check; the new pending baseline is returned. */
async function editedBaseline(box) {
  const added = await box.inProcess(box.repo, 'add', 'web', 'Editable', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const edited = await box.inProcess(box.repo, 'edit', String(id), '--check', 'node --test web/other.test.js', '--reason', 'the check names the other test', '--json');
  assert.equal(edited.code, 0, edited.err + edited.out);
  return onBoard(box, board => store.getItem(board, id).item_check_baseline);
}

test('cli.io-commands-edit.strict-baseline-on: clause 2: with claim.checkCeiling on, edit --check with a new command writes a pending baseline carrying strict true [C7,#1273]', async () => {
  const box = helpers.project();
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { claim: { checkCeiling: true } });
  const baseline = await editedBaseline(box);
  assert.equal(baseline.command, 'node --test web/other.test.js');
  assert.equal(baseline.strict, true);
});

test('cli.io-commands-edit.strict-baseline-off: clause 2: with claim.checkCeiling off, edit --check writes a baseline with no strict field [C7,#1273]', async () => {
  const baseline = await editedBaseline(helpers.project());
  assert.equal(baseline.command, 'node --test web/other.test.js');
  assert.equal('strict' in baseline, false);
});

test('cli.edit.needs-flag: clause 2: edit --needs gui replaces the list and edit --needs "" clears it to [] [C7,#11206]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Needs edit', '--specs', 'G1', '--needs', 'browser,gui', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const needsOf = async () => JSON.parse((await box.inProcess(box.repo, 'show', id, '--json')).out).item_needs;
  const replaced = await box.inProcess(box.repo, 'edit', id, '--needs', 'gui', '--json');
  assert.equal(replaced.code, 0, replaced.err + replaced.out);
  assert.deepEqual(await needsOf(), ['gui']);
  const cleared = await box.inProcess(box.repo, 'edit', id, '--needs', '', '--json');
  assert.equal(cleared.code, 0, cleared.err + cleared.out);
  assert.deepEqual(await needsOf(), []);
});

test('cli.edit.specs-flag: clause 1: edit --specs G2,K3 --reason replaces an open item\'s cited rows and show reports them [C7,#12104]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Specs edit', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const edited = await box.inProcess(box.repo, 'edit', id, '--specs', 'G2,K3', '--reason', 'the item cites other rows', '--json');
  assert.equal(edited.code, 0, edited.err + edited.out);
  const shown = JSON.parse((await box.inProcess(box.repo, 'show', id, '--json')).out).item;
  assert.equal(shown.item_spec_ids, 'G2,K3');
});
