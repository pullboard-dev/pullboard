/** A green baseline warns everywhere, and gates, clears and an unborn main change its record [V2,H3,H16]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  BOARD_FILE,
  project,
  fileCheck,
  addChecked,
  cleanupFixtures,
} from '../../tests/fixtures/check-baseline.js';
import { exportBoard } from '../../../../packages/store/index.js';

after(cleanupFixtures);

/** Read a native snapshot from a replica, including its event and metadata tables. */
function snapshotFile(file) {
  return withBoard(file, exportBoard);
}

test('[V2,H3,H16] green baseline warns through add edit show and private next verify', async function greenBaselineWarnings() {
  const box = project({ content: 'green', worktrees: true });
  const check = fileCheck('green', 'first-check-marker.txt');
  const { result: added, item } = addChecked(box, 'Green baseline warning', check);
  assert.match(added.stdout, /CRITERION_PROVES_NOTHING/u);
  assert.equal(item.item_check_baseline.result, 'green');
  assert.equal(item.item_check_baseline.main, box.git(box.repo, 'rev-parse', 'refs/heads/main'));
  assert.equal(existsSync(join(box.repo, 'first-check-marker.txt')), false, 'the passing baseline ran in its temporary clone');

  const changedCheck = fileCheck('green', 'edited-check-marker.txt');
  const edited = box.run(box.repo, ['edit', String(item.item_id), '--check', changedCheck, '--wait', '--json']);
  assert.equal(edited.status, 0, `${edited.stdout}${edited.stderr}`);
  assert.equal(edited.stderr, '', 'edit writes no baseline diagnostics to stderr');
  assert.match(edited.stdout, /CRITERION_PROVES_NOTHING/u);
  assert.equal(JSON.parse(edited.stdout).item.item_check_baseline.command, changedCheck);
  assert.equal(existsSync(join(box.repo, 'edited-check-marker.txt')), false, 'the edited baseline also ran in a temporary clone');

  const shown = box.run(box.repo, ['show', String(item.item_id)]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /CRITERION_PROVES_NOTHING/u);
  const textAdded = box.run(box.repo, ['add', 'web', 'Text baseline warning', '--check', check, '--wait']);
  assert.equal(textAdded.status, 0, textAdded.stderr);
  assert.match(textAdded.stdout, /warning: \[CRITERION_PROVES_NOTHING\]/u);
  const textEdited = box.run(box.repo, ['edit', String(item.item_id), '--check', `${changedCheck}\n# a distinct command`, '--wait']);
  assert.equal(textEdited.status, 0, textEdited.stderr);
  assert.match(textEdited.stdout, /warning: \[CRITERION_PROVES_NOTHING\]/u);

  const claimed = box.run(box.web, ['next']);
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  writeFileSync(join(box.web, 'web', 'proof.txt'), 'submitted\n');
  box.git(box.web, 'add', 'web/proof.txt');
  box.git(box.web, 'commit', '-q', '-m', 'test: submit green check baseline fixture');
  const submitted = box.run(box.web, ['submit', String(item.item_id)]);
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);

  const review = box.run(box.review, ['next', '--verify']);
  assert.equal(review.status, 0, `${review.stdout}${review.stderr}`);
  assert.match(review.stdout, /CRITERION_PROVES_NOTHING/u);
});

test('[V2,H3,H16] repo gates execute before baselines report green and preserve clear and missing-main states', async function baselineTransitions() {
  const box = project({ content: 'green' });
  const gateMarker = join(box.dir, 'repo-gate-marker.txt');
  const gate = fileCheck('green', gateMarker);
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), gate }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set the fixture gate');
  const { item: gated } = addChecked(box, 'Gate check', gate);
  assert.equal(gated.item_check_baseline.command, gate);
  assert.equal(gated.item_check_baseline.main, box.git(box.repo, 'rev-parse', 'refs/heads/main'));
  assert.equal(gated.item_check_baseline.result, 'green');
  assert.equal(gated.item_check_baseline.reason, undefined, 'a matching gate receives an actual measurement');
  assert.equal(gated.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(existsSync(gateMarker), true, 'an exact gate match runs its command in the temporary clone');

  const metadataEdit = box.run(box.repo, ['edit', String(gated.item_id), '--brief', 'updated brief', '--json']);
  assert.equal(metadataEdit.status, 0, `${metadataEdit.stdout}${metadataEdit.stderr}`);
  assert.deepEqual(JSON.parse(metadataEdit.stdout).item.item_check_baseline, gated.item_check_baseline,
    'an edit that leaves the check unchanged retains the measured baseline');

  const changedExecutions = join(box.dir, 'changed-check-executions.txt');
  const changedCheck = fileCheck('green', 'changed-check-marker.txt', changedExecutions);
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), gate: changedCheck }));
  const changed = box.run(box.repo, ['edit', String(gated.item_id), '--check', changedCheck, '--wait', '--json']);
  assert.equal(changed.status, 0, `${changed.stdout}${changed.stderr}`);
  const changedBaseline = JSON.parse(changed.stdout).item.item_check_baseline;
  assert.equal(changedBaseline.command, changedCheck);
  assert.equal(changedBaseline.main, gated.item_check_baseline.main);
  assert.equal(changedBaseline.result, 'green');
  assert.equal(changedBaseline.reason, undefined, 'a dirty config cannot turn a new check into the committed main gate');
  assert.equal(readFileSync(changedExecutions, 'utf8').trim().split('\n').length, 1, 'the dirty-config check really runs once at main');
  assert.equal(existsSync(join(box.repo, 'changed-check-marker.txt')), false, 'changed checks run only in the temporary main clone');

  const cleared = box.run(box.repo, ['edit', String(gated.item_id), '--check', '', '--json']);
  assert.equal(cleared.status, 0, `${cleared.stdout}${cleared.stderr}`);
  assert.equal(JSON.parse(cleared.stdout).item.item_check, '');
  assert.equal(Object.hasOwn(JSON.parse(cleared.stdout).item, 'item_check_baseline'), false, 'clearing a check clears its baseline');
  assert.ok(!snapshotFile(join(box.repo, BOARD_FILE)).tables.board_meta.some((row) => row.meta_key === `item_check_baseline_${gated.item_id}`), 'clearing also removes the persisted baseline metadata');

  const unborn = project({ commit: false });
  const noMainCheck = fileCheck('green', 'unborn-check-marker.txt');
  const { item: unavailable } = addChecked(unborn, 'Unborn main baseline', noMainCheck);
  assert.deepEqual(unavailable.item_check_baseline, {
    command: noMainCheck, main: null, result: 'unavailable', reason: 'no main',
  }, 'an unborn main reports unavailable without refusing item creation');
  assert.equal(existsSync(join(unborn.repo, 'unborn-check-marker.txt')), false, 'no-main handling never falls back to the live checkout');
});
