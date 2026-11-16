/** Next names the item folder, its frozen bar and the shouts and rulings that name the item [C7,#8787]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Turn next.itemNotices on or off for this fixture's machine, keeping the settings the fixture wrote. */
function itemNotices(on) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next: { itemNotices: on } }));
}

/** Run next as a person reads it, with no --json, and return everything it printed. */
async function printed(box, cwd) {
  let out = '';
  const stdout = { isTTY: false, write: part => { out += part; } };
  const code = await main(['next'], { cwd, clock: box.clock, stdout, stderr: stdout });
  assert.equal(code, 0, out);
  return out;
}

/** An item with one shout and one ruling that name it, handed to the actor by next. */
async function handed(t, on) {
  const box = await fixture(t);
  const id = box.add('Item with notices');
  store.shout(box.board, { from: 'coordinator', to: 'all', item: id, text: 'Mind the web folder boundary', lanes: ['web'] });
  store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'decision', text: 'Ruling: keep the old name' });
  itemNotices(on);
  const taken = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  return { box, id, document: taken.document };
}

test('clause 1: the instruction next returns names the item folder and its frozen bar [C7,#8787]', async t => {
  const box = await fixture(t);
  box.add('Item with a bar');
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, /item folder: \S+/u, 'the instruction names the item folder');
  assert.match(text, /criterion: The real fixture succeeds\./u, 'the instruction names the frozen bar');
});

test('clause 2: the same instruction lists the shouts and rulings that name the item [C7,#8787]', async t => {
  const { document } = await handed(t, true);
  assert.ok(document.notices.some(line => line.includes('Mind the web folder boundary')), 'the shout names the item');
  assert.ok(document.notices.some(line => line.includes('keep the old name')), 'the ruling names the item');
});

test('clause 2: with next.itemNotices off the instruction lists no notices [C7,#8787]', async t => {
  const { document } = await handed(t, false);
  assert.equal(Object.hasOwn(document, 'notices'), false);
});
