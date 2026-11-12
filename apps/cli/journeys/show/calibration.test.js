/** Defaults, check-file brief inference and one-step route feedback through real coordinator and seat commands [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
test.after(helpers.cleanup);

test('an inferred one-file light item moves to mid after its matched seat releases it once [C7]', async () => {
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Route calibration fixture';
  const box = helpers.project('true', isolated);
  const lightSeat = box.dir + '/light-seat';
  box.git(box.repo, 'worktree', 'add', '-q', lightSeat, '-b', 'web/light-seat');
  assert.match(fixtureJoin(box.run, lightSeat, 'web', '--route', 'light').out, /joined as web-/u);
  const itemResult = fixtureAdd(box.run, box.repo, 'web', 'Small calibration item', '--criterion', 'Update the one-file helper', '--check', 'node --test apps/cli/journeys/show/calibration.test.js', '--specs', 'G1', '--route', 'mid', '--json'); // a bare fixture add files strong (dbb187a273), so the mid start is named
  assert.equal(itemResult.code, 0, itemResult.out + itemResult.err);
  const id = JSON.parse(itemResult.out).item.item_id;
  assert.equal(JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json')).out).item_route, 'mid', 'work added at mid stays mid until diagnosed');
  const diagnosis = await box.inProcess(box.repo, 'fact', String(id), 'diagnosis',
    'Files: web/calibration.js Change: update the one-file helper Test case: route calibration chooses the matched seat', '--json');
  assert.equal(diagnosis.code, 0, diagnosis.out + diagnosis.err);
  const lowered = await box.inProcess(box.repo, 'edit', String(id), '--route', 'light', '--json');
  assert.equal(lowered.code, 0, lowered.out + lowered.err);
  assert.equal(JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json')).out).item_route, 'light');
  const light = await box.inProcess(lightSeat, 'next', '--build', '--json');
  assert.equal(light.code, 0, light.out + light.err);
  assert.equal(JSON.parse(light.out).item.item_id, id);
  writeFileSync(join(lightSeat, 'route-attempt.txt'), 'the light seat attempted its diagnosis\n');
  const release = await box.inProcess(lightSeat, 'release', String(id), '--reason', 'BUDGET', '--note', 'The matched light route reached its bounded budget', '--no-next', '--json');
  assert.equal(release.code, 0, release.out + release.err);
  assert.equal(JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json')).out).item_route, 'mid');
  const mid = box.dir + '/mid-seat';
  box.git(box.repo, 'worktree', 'add', '-q', mid, '-b', 'web/mid-seat');
  assert.match(fixtureJoin(box.run, mid, 'web', '--route', 'mid').out, /joined as web-/u);
  const selected = await box.inProcess(mid, 'next', '--build', '--json');
  assert.equal(selected.code, 0, selected.out + selected.err);
  assert.equal(JSON.parse(selected.out).item.item_id, id);
  const lightAgain = await box.inProcess(lightSeat, 'next', '--build', '--json');
  assert.notEqual(lightAgain.code, 0, 'a light seat cannot take the item after it moves to mid');
});
