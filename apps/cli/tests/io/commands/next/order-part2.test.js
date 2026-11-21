/** Next order: path, milestone and lane hand-off precedence [N2,B13,B16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureAdd } from '../../../fixtures/testkit.js';

test('cli.journeys-next-order-part2.next-in-the-main-checkout-names: next in the main checkout names the lane worktree to join [N2,B26]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'fresh-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal((await box.runLocal(repo, 'lane', 'add', 'app', '--owns', 'app/')).code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the fresh board');
  for (const title of ['First app item', 'Second app item']) {
    const added = await fixtureAdd(box.runLocal, repo, 'app', title, '--route', 'strong',
      '--criterion', 'The app item creates its readiness marker.', '--check', 'test -f app/ready', '--json');
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  }
  const json = (await box.runLocal(repo, 'next', '--json'));
  assert.equal(json.code, 1, json.out);
  const refusal = JSON.parse(json.out).error;
  assert.equal(refusal.code, 'NOTHING_FREE', 'the empty coordinator queue keeps its refusal code');
  assert.match(refusal.message, /2 items open in lane app/u);
  assert.equal(refusal.next, 'pullboard worktree app --model "<model name>"');
  assert.doesNotMatch(refusal.message + refusal.next, /wait|keep looking/iu);
  for (const args of [[], ['--wait', '0.01']]) {
    const text = (await box.runLocal(repo, 'next', ...args));
    assert.equal(text.code, 1);
    assert.match(text.err, /2 items open in lane app/u);
    assert.match(text.err, /pullboard worktree app --model "<model name>"/u);
    assert.doesNotMatch(text.err, /pullboard next --wait|keep looking/iu);
  }
  const opened = (await box.runLocal(repo, 'worktree', 'app', '--model', 'Newcomer test', '--json'));
  assert.equal(opened.code, 0, `${opened.out}\n${opened.err}`);
  const seat = JSON.parse(opened.out);
  const next = (await box.runLocal(seat.path, 'next', '--build', '--json'));
  assert.equal(next.code, 0, `${next.out}\n${next.err}`);
  assert.equal(JSON.parse(next.out).item.item_lane, 'app', 'the suggested command reaches work through the normal claim');
  const idle = helpers.project('true');
  const empty = JSON.parse((await idle.runLocal(idle.repo, 'next', '--build', '--json')).out).error;
  assert.equal(empty.code, 'NOTHING_FREE');
  assert.equal(empty.next, 'To keep looking: pullboard next --take', 'an idle board points to the bounded native take');
  const plain = await idle.runLocal(idle.repo, 'next', '--json');
  assert.equal(plain.code, 0, 'plain next on an idle board finishes without waiting');
  assert.equal(JSON.parse(plain.out).next, 'nothing for this seat: end your turn', 'the plain loop ends the turn instead of refusing');
});
