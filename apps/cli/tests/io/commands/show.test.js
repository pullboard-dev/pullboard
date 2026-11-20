/** show prints the after-gate ids beside the after line only when the list is not empty, and the measured minutes and rebuilds under it [C7,#11802,#12327]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { thinShowFacts } from '../../../src/io/show/thin.js';

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

/** Turn read.thinCommands on or off in the fixture machine's settings file, keeping its other settings. */
function setThin(box, on) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.read = { thinCommands: on };
  writeFileSync(file, JSON.stringify(settings));
}

/** The text and exit code of `pullboard show <id>` with read.thinCommands on or off. */
async function shownThin(box, id, on) {
  setThin(box, on);
  const shown = await box.runLocal(box.repo, 'show', String(id));
  return { out: shown.out, err: shown.err, code: shown.code };
}

test('cli.commands-show.thin-equal: clause 1: with read.thinCommands on, show of a fixture item with no receipt, refusal or thread prints the same lines and exit code as with it off [C7,#12413]', async (t) => {
  const box = helpers.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin show plain item');
  assert.equal(added.code, 0, added.err);
  assert.ok(await thinShowFacts({ cwd: box.repo, id: 1 }), 'the thin door serves this plain item');
  const off = await shownThin(box, 1, false);
  const on = await shownThin(box, 1, true);
  assert.equal(off.code, 0, off.err);
  assert.equal(on.code, off.code, on.err);
  assert.equal(on.out, off.out);
  assert.match(off.out, /Thin show plain item/u);
});

test('cli.commands-show.thin-null-falls-back: clause 2: with read.thinCommands on, show of an item with a receipt or a thread entry prints the full path lines, the thin door returning null [C7,#12413]', async (t) => {
  const box = helpers.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin show noted item');
  assert.equal(added.code, 0, added.err);
  const noted = await box.runLocal(box.repo, 'fact', '1', 'note', 'a thread entry the thin door leaves to the full path');
  assert.equal(noted.code, 0, noted.err);
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 1 }), null, 'the thin door steps aside for an item with a thread entry');
  const off = await shownThin(box, 1, false);
  const on = await shownThin(box, 1, true);
  assert.equal(on.code, off.code, on.err);
  assert.equal(on.out, off.out);
  assert.match(on.out, /a thread entry the thin door leaves to the full path/u);
});
