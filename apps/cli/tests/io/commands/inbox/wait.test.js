/** @pullboard-test-input source-cell apps/cli */
/** pullboard inbox --wait blocks until a shout to the coordinator or until nothing is open [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../fixtures/testkit.js';

const SHOUT = 'which path should the seat take for the ruling';

test('cli.journeys-inbox-wait.returns-on-coordinator-shout: clause 1: inbox --wait 1 blocks, then returns within 10 s of a shout addressed to the coordinator, printing that shout [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Open work', criterion: 'the installed check passes', check: 'true', args: ['--specs', 'G1'] });
  const idle = await box.runAsync(box.repo, 'inbox', '--wait', '0.01');
  assert.equal(idle.code, 0, `${idle.out}${idle.err}`);
  assert.match(idle.out, /no shout in 0\.01 minutes; 1 item is still open/u, 'with an item open and no shout, the wait runs to its deadline');
  const waiting = box.runAsync(box.repo, 'inbox', '--wait', '1');
  const sent = await box.inProcess(box.web, 'shout', 'coordinator', SHOUT, '--kind', 'question');
  assert.equal(sent.status, 0, `${sent.stdout}${sent.stderr}`);
  const answer = await waiting;
  assert.equal(answer.code, 0, `${answer.out}${answer.err}`);
  assert.match(answer.out, new RegExp(SHOUT, 'u'), 'the shout is printed, not the one-minute timeout line');
  assert.doesNotMatch(answer.out, /no shout in/u);
});

test('cli.journeys-inbox-wait.returns-when-nothing-open: clause 1: inbox --wait 1 returns at once, printing that nothing is open, when every item is landed or withdrawn [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const answer = await box.runAsync(box.repo, 'inbox', '--wait', '1');
  assert.equal(answer.code, 0, `${answer.out}${answer.err}`);
  assert.match(answer.out, /nothing is open/u);
});
