/** show prints the after-gate ids beside the after line only when the list is not empty, and the measured minutes and rebuilds under it [C7,#11802,#12327]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Files an item with the given wait flag on a fresh prerequisite and returns the text of its show. */
async function shownAfter(flag, notes = []) {
  const box = helpers.project();
  const base = ['--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js'];
  const first = await box.inProcess(box.repo, 'add', 'web', 'Prerequisite', ...base, '--json');
  assert.equal(first.code, 0, first.err + first.out);
  const firstId = JSON.parse(first.out).item.item_id;
  for (const text of notes) {
    const noted = await box.inProcess(box.repo, 'fact', String(firstId), 'note', text.replace('#7', `#${firstId}`));
    assert.equal(noted.code, 0, noted.err + noted.out);
  }
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

test('cli.commands-show.after-gate-measure-line: clause 1: show prints the minutes saved and rebuilds summed from the after-gate parent notes right after the after-gate line [C7,#12327]', async () => {
  const { text, firstId } = await shownAfter('--after-gate', ['after-gate saved: #7 12 min', 'after-gate rebuild: #7 goes back and is rebuilt']);
  assert.match(text, new RegExp(`^after-gate #${firstId}\\nafter-gate: 12 min saved, 1 rebuilds$`, 'mu'));
});

test('cli.commands-show.no-after-gate-measure-line: clause 2: show prints no minutes line for a plain --after or for an after-gate parent with no after-gate notes [C7,#12327]', async () => {
  assert.doesNotMatch((await shownAfter('--after')).text, /min saved/u);
  assert.doesNotMatch((await shownAfter('--after-gate')).text, /min saved/u);
});
