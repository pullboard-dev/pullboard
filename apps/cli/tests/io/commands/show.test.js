/** show prints the after-gate ids beside the after line only when the list is not empty [C7,#11802]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Files an item with the given wait flag on a fresh prerequisite and returns the text of its show. */
async function shownAfter(flag) {
  const box = helpers.project();
  const base = ['--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js'];
  const first = await box.inProcess(box.repo, 'add', 'web', 'Prerequisite', ...base, '--json');
  assert.equal(first.code, 0, first.err + first.out);
  const firstId = JSON.parse(first.out).item.item_id;
  const second = await box.inProcess(box.repo, 'add', 'web', 'Waiting item', ...base, flag, String(firstId), '--json');
  assert.equal(second.code, 0, second.err + second.out);
  const shown = await box.inProcess(box.repo, 'show', String(JSON.parse(second.out).item.item_id));
  assert.equal(shown.code, 0, shown.err + shown.out);
  return { text: shown.out, firstId };
}

test('cli.commands-show.after-gate-line: clause 2: show prints an after-gate line naming the ids for an item filed with --after-gate [C7,#11802]', async () => {
  const { text, firstId } = await shownAfter('--after-gate');
  assert.match(text, new RegExp(`^after-gate #${firstId}$`, 'mu'));
});

test('cli.commands-show.no-after-gate-line: clause 2: show prints no after-gate line for an item filed with a plain --after [C7,#11802]', async () => {
  const { text } = await shownAfter('--after');
  assert.doesNotMatch(text, /after-gate/u);
});
