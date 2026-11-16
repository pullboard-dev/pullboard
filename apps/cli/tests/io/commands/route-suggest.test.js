/** `route --suggest` lists the open strong items that meet the light shape and edits none of them [C7,#3081]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const SMALL = ['--criterion', 'the handler returns the canonical result [test]', '--check', 'node --test web/handler.test.js', '--brief', 'Files: web/handler.js\nChange: fix\nTest: web/handler.test.js'];

/** Add one item with the given arguments and return its id. */
async function addItem(box, title, ...extra) {
  const added = await box.inProcess(box.repo, 'add', 'web', title, '--specs', 'G1', '--json', ...extra);
  assert.equal(added.code, 0, added.err + added.out);
  return JSON.parse(added.out).item.item_id;
}

test('clause 1: route --suggest lists the open strong items whose shape meets the light rule and edits none of them [C7,#3081]', async () => {
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_FIXTURE_ROUTES = 'board';
  const box = helpers.project('true', isolated);
  const fits = await addItem(box, 'Small strong item', ...SMALL, '--route', 'strong');
  const noBrief = await addItem(box, 'Strong without a brief', '--criterion', 'the handler returns the canonical result [test]', '--check', 'npm test', '--route', 'strong');
  const wide = await addItem(box, 'Strong with four files', '--route', 'strong', '--check', 'node --test web/handler.test.js', '--brief', 'Files: web/handler.js',
    '--criterion', 'web/a.js, web/b.js, web/c.js and web/d.js behave the same [test]');
  const mid = await addItem(box, 'Small mid item', ...SMALL, '--route', 'mid');
  const before = await box.inProcess(box.repo, 'list', '--all', '--json');

  const suggested = await box.inProcess(box.repo, 'route', '--suggest', '--json');
  assert.equal(suggested.code, 0, suggested.err + suggested.out);
  assert.deepEqual(JSON.parse(suggested.out).items.map(item => item.id), [fits], `not #${noBrief} #${wide} #${mid}`);

  const after = await box.inProcess(box.repo, 'list', '--all', '--json');
  assert.equal(after.out, before.out, 'the board is unchanged');
  const bare = await box.inProcess(box.repo, 'route');
  assert.equal(bare.code === 0, false, 'route without --suggest refuses');
});
