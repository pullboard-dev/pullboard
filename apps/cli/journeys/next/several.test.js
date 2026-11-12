/** With N live claims allowed, one next claims several ready items whose files are disjoint, each in its own folder [C7,#6263]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';

/** Four ready items: the first two share web/shared.js, the others stand alone. */
function fourItems(box) {
  const brief = file => `Files: ${file}\nTest: the real board selects the eligible item.`;
  return [box.add('Shared one', { brief: brief('web/shared.js') }), box.add('Shared two', { brief: brief('web/shared.js') }),
    box.add('Alone three', { brief: brief('web/three.js') }), box.add('Alone four', { brief: brief('web/four.js') })];
}

/** Set claims.perSeat for the seat's own checkout. */
function setN(box, n) {
  const file = join(box.seats.actor.path, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), claims: { perSeat: n } }));
}

test('clause 1: with N=3 and four ready items where two share a file, one next claims three with disjoint files [C7]', async t => {
  const box = await fixture(t);
  const [one, two, three, four] = fourItems(box);
  setN(box, 3);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const statuses = [one, two, three, four].map(id => `#${id} ${box.board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status}`).join(', ');
  const held = id => box.board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id);
  const shared = [one, two].filter(id => held(id).item_status === 'claimed');
  assert.equal(shared.length, 1, 'exactly one of the two items sharing a file is claimed');
  assert.equal(held(three).item_status, 'claimed', `${statuses}\n${result.out}\n${result.err}`);
  assert.equal(held(four).item_status, 'claimed', `${statuses}\n${result.out}\n${result.err}`);
  for (const id of [shared[0], three, four]) {
    const folder = `${box.seats.actor.path}-item-${id}`;
    assert.match(box.git(folder, 'rev-parse', '--show-toplevel').trim(), new RegExp(`item-${id}$`, 'u'), 'its own item folder is open');
    assert.ok(result.out.includes(folder), `the output names ${folder}`);
    assert.ok(result.out.includes(`#${id}`), `the output names #${id}`);
  }
  assert.equal(result.out.split('The real fixture succeeds.').length - 1 >= 3, true, 'each bar is printed');
});

test('clause 2: with N=1, next claims one item exactly as before [C7]', async t => {
  const box = await fixture(t);
  const [one, , three] = fourItems(box);
  setN(box, 1);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const status = id => box.board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status;
  assert.equal(status(one), 'claimed');
  assert.equal(status(three), 'open', 'no second claim at N=1');
});
