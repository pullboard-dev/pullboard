/** `pullboard edit --title` retitles an item and keeps the old title in the thread's edit event [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require success before parsing a command's public JSON contract. */
function json(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('edit --title shows the new title, keeps the old one in the edit event and refuses an empty title [C7]', { timeout: 180_000 }, async t => { // budget: hang ceiling for private Git/SQLite add and edit commands.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = json(await fixtureAdd(box.runLocal, box.repo, 'web', 'Main red: test/x.test.js fails', '--criterion', 'The result file exists.',
    '--check', 'test -f web/result.txt', '--wait', '--json')).item.item_id;

  const empty = await box.runLocal(box.repo, 'edit', String(id), '--title', '   ', '--json');
  assert.equal(empty.code, 1, empty.out + empty.err);
  assert.equal(JSON.parse(empty.out).error.code, 'USAGE');
  assert.equal(json(await box.runLocal(box.repo, 'show', String(id), '--json')).item_title, 'Main red: test/x.test.js fails', 'a refused title changes nothing');

  const edited = json(await box.runLocal(box.repo, 'edit', String(id), '--title', 'Main red: apps/cli/journeys/x.test.js fails', '--reason', 'layout freeze moved the file', '--json'));
  assert.equal(edited.item.item_title, 'Main red: apps/cli/journeys/x.test.js fails');
  const shown = json(await box.runLocal(box.repo, 'show', String(id), '--json'));
  assert.equal(shown.item_title, 'Main red: apps/cli/journeys/x.test.js fails');
  const event = shown.thread.find(entry => entry.type === 'move' && entry.kind === 'edit');
  assert.ok(event, JSON.stringify(shown.thread));
  assert.equal(event.detail.previousTitle, 'Main red: test/x.test.js fails');
  assert.equal(event.detail.title, 'Main red: apps/cli/journeys/x.test.js fails');
  const text = await box.runLocal(box.repo, 'show', String(id));
  assert.match(text.out, /title was: Main red: test\/x\.test\.js fails/u);
  assert.equal(shown.item_criterion, 'The result file exists.', 'a title edit leaves the bar alone');
  assert.equal(shown.item_status, 'open');
});
