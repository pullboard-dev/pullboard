/** next.lightShapedStrong offers a light seat a light-shaped strong item only when no light item is free, and is off by default [C7,#9568]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Write this fixture machine's next settings, keeping the settings the fixture wrote. */
function nextSettings(next) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next }));
}

/** An open strong item with one clause, one existing test file and one brief file: light-shaped. */
function shapedStrong(box) {
  const id = box.add('Light-shaped strong item', { route: 'strong', criterion: '1. The shaped fixture succeeds [test].',
    check: 'node --test web/shaped.test.js',
    // Written as Files, Change and Test case, the brief is its own diagnosis, so a light seat may build from it.
    brief: 'Files: web/dispatch.js\nChange: prepare a small dispatch fixture\nTest case: native next offers the item to the light seat.' });
  return id;
}

/** The item the real next offers the light actor seat, or null. */
async function offered(box) {
  const answer = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(answer.code, 0, answer.out + answer.err);
  return answer.document.item?.item_id ?? `none: ${answer.out}`;
}

test('cli.journeys-next-shaped.with-next-lightshapedstrong-on-and-no: clause 1: with next.lightShapedStrong on and no free light item, the real next from a light seat offers an unheld light-shaped strong item [C7,#9568]', async t => {
  const box = await fixture(t, { route: 'light' });
  const shaped = shapedStrong(box);
  box.add('Wrong route and not light-shaped', { route: 'strong' });
  nextSettings({ lightShapedStrong: true });
  assert.equal(await offered(box), shaped, 'the shaped strong item is offered');
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(shaped)]);
  assert.equal(claimed.code, 0, `the light seat claims what next offered: ${claimed.out}${claimed.err}`);
});

test('cli.journeys-next-shaped.the-light-shaped-strong-item-is: clause 2: the light-shaped strong item is not offered while a light item is free [C7,#9568]', async t => {
  const box = await fixture(t, { route: 'light' });
  shapedStrong(box);
  const light = box.add('Free light item', { route: 'light' });
  nextSettings({ lightShapedStrong: true });
  assert.equal(await offered(box), light);
});

test('cli.journeys-next-shaped.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, it is not offered [C7,#9568]', async t => {
  const box = await fixture(t, { route: 'light' });
  const shaped = shapedStrong(box);
  assert.notEqual(await offered(box), shaped, 'the default is off');
  nextSettings({ lightShapedStrong: false });
  assert.notEqual(await offered(box), shaped, 'an explicit false is off');
});
