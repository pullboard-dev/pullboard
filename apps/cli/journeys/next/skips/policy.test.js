/** next and claim never pass over or refuse an item for a policy change; the bar alone is frozen [B4,C7,L2,V3]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

/** Require each actual native fixture command to finish successfully. */
async function success(box, cwd, ...args) {
  const result = (await box.runLocal(cwd, ...args));
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

test('clause 1: next claims an item whose lane policy changed after its freeze, never skipping it [B4,C7]', async t => {
  const box = barChangedThenFresh(t);
  const first = (await box.runLocal(box.web, 'next'));
  assert.equal(first.code, 0, first.err || first.out);
  assert.doesNotMatch(first.out, /skipped #1|NO_POLICY/u);
  assert.match(first.out, /claimed #1: Stale item/u);
});

test('clause 2: no stale-policy marker or coordinator shout is raised for a policy change [B4,B7]', t => {
  const box = barChangedThenFresh(t);
  success(box, box.web, 'next');
  const shown = success(box, box.repo, 'show', '1', '--json').out;
  assert.equal(shown.split('staleFrozenPolicy').length - 1, 0, 'no marker fact');
  assert.doesNotMatch(success(box, box.repo, 'inbox').out, /next passes over #1/u, 'no shout to the coordinator');
});

test('clause 3: a shrunk owns list that moves no path the bar names refreshes at claim (#3793) [L2,V3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  commitConfig(box, config => { config.lanes.web.owns = ['web/', 'assets/']; }, 'chore: grow web lane');
  success(box, box.repo, 'add', 'web', 'Shrunk item', '--specs', 'G1', '--criterion', 'The page renders.');
  success(box, box.repo, 'refreeze', '1');
  commitConfig(box, config => { config.lanes.web.owns = ['web/']; }, 'chore: shrink web lane');
  const result = (await box.runLocal(box.web, 'next'));
  assert.equal(result.code, 0, result.err || result.out);
  assert.doesNotMatch(result.out, /NO_POLICY/u);
  assert.match(result.out, /claimed #1: Shrunk item/u);
});

test('claim by id on an item whose lane policy changed claims it, never NO_POLICY [B4,C7]', async t => {
  const box = barChangedThenFresh(t);
  const result = (await box.runLocal(box.web, 'claim', '1'));
  assert.equal(result.code, 0, result.err || result.out);
  assert.doesNotMatch(`${result.out}${result.err}`, /NO_POLICY/u);
});
