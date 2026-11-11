/** next passes over an item frozen under an older submit policy; claim by id still refuses NO_POLICY [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

/** Require each actual native fixture command to finish successfully. */
function success(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

/** Commit a change to the web lane's policy on main, as the coordinator does. */
function changeWebLane(box) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.lanes.web.owns = [...config.lanes.web.owns, 'assets/'];
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: change web lane policy');
}

/** Two open web items: #1 frozen before a lane policy change, #2 added after it. */
function staleThenFresh(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  success(box, box.repo, 'add', 'web', 'Stale item', '--specs', 'G1', '--criterion', 'The page renders.');
  success(box, box.repo, 'refreeze', '1');
  changeWebLane(box);
  success(box, box.repo, 'add', 'web', 'Fresh item', '--specs', 'G1', '--criterion', 'The footer renders.');
  success(box, box.repo, 'refreeze', '2');
  return box;
}

test('next hands the seat a buildable item instead of refusing NO_POLICY on a stale one [C7]', t => {
  const box = staleThenFresh(t);
  const result = box.run(box.web, 'next');
  assert.equal(result.code, 0, result.err || result.out);
  assert.match(result.out, /skipped #1: \[NO_POLICY\]/, 'the stale item is named, not refused');
  assert.match(result.out, /claimed #2: Fresh item/);
});

test('claim by id on the stale item still refuses NO_POLICY with its refresh step [C7]', t => {
  const box = staleThenFresh(t);
  const result = box.run(box.web, 'claim', '1');
  assert.notEqual(result.code, 0);
  assert.match(`${result.out}${result.err}`, /NO_POLICY[\s\S]*refresh the item/);
});
