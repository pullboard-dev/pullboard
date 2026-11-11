/** next passes over an item frozen under an older submit policy; claim by id still refuses NO_POLICY [C7,L2,V3]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';

/** Require each actual native fixture command to finish successfully. */
function success(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

/** Commit one change to pullboard.json on main, as the coordinator does. */
function commitConfig(box, change, message) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', message);
}

/** #1 frozen, then its lane's specs change (a bar-changing policy move), then fresh #2 and #3. */
function barChangedThenFresh(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  success(box, box.repo, 'add', 'web', 'Stale item', '--specs', 'G1', '--criterion', 'The page renders.');
  success(box, box.repo, 'refreeze', '1');
  commitConfig(box, config => { config.lanes.web.specs = ['G1', 'G2']; }, 'chore: widen web specs');
  for (const title of ['Fresh item', 'Third item']) {
    success(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', `${title} renders.`);
  }
  return box;
}

test('clause 1: next skips an item whose lane policy changed its bar and claims the next one (#3793) [C7]', t => {
  const box = barChangedThenFresh(t);
  const first = box.run(box.web, 'next');
  assert.equal(first.code, 0, first.err || first.out);
  assert.match(first.out, /skipped #1: \[NO_POLICY\] #1 is frozen against an older accepted policy/u);
  assert.match(first.out, /claimed #2: Fresh item/u);
});

test('clause 2: the coordinator hears of a stale item once per frozen bar, not once per next (#3793) [C7,B7]', t => {
  const box = barChangedThenFresh(t);
  success(box, box.web, 'next');
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.equal(joinFixtureSeat(box, second, 'web', { model: 'fixture-model' }).code, 0);
  const again = success(box, second, 'next');
  assert.match(again.out, /skipped #1: \[NO_POLICY\]/u, 'a second seat still passes over it');
  assert.match(again.out, /claimed #3: Third item/u);
  const shown = success(box, box.repo, 'show', '1', '--json').out;
  assert.equal(shown.split('staleFrozenPolicy').length - 1, 1, 'one marker fact on the stale item');
  const inbox = success(box, box.repo, 'inbox').out;
  assert.equal(inbox.split('next passes over #1 until it is refrozen').length - 1, 1, 'one shout to the coordinator');
});

test('clause 3: a shrunk owns list that moves no path the bar names refreshes at claim (#3793) [L2,V3]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  commitConfig(box, config => { config.lanes.web.owns = ['web/', 'assets/']; }, 'chore: grow web lane');
  success(box, box.repo, 'add', 'web', 'Shrunk item', '--specs', 'G1', '--criterion', 'The page renders.');
  success(box, box.repo, 'refreeze', '1');
  commitConfig(box, config => { config.lanes.web.owns = ['web/']; }, 'chore: shrink web lane');
  const result = box.run(box.web, 'next');
  assert.equal(result.code, 0, result.err || result.out);
  assert.doesNotMatch(result.out, /NO_POLICY/u);
  assert.match(result.out, /claimed #1: Shrunk item/u);
});

test('claim by id on the stale item still refuses NO_POLICY and names the refreeze [C7]', t => {
  const box = barChangedThenFresh(t);
  const result = box.run(box.web, 'claim', '1');
  assert.notEqual(result.code, 0);
  assert.match(`${result.out}${result.err}`, /NO_POLICY[\s\S]*refreezes #1/u);
});
