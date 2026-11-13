/** With N live claims allowed, next tops a seat up to N ready items whose files are disjoint, each in its own folder, and submit adds one more [C7,#6263,#7461]. */
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
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), claims: { releaseGone: false, releaseCooldownMinutes: 30, perSeat: n } }));
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
  const printed = [result.document.item, ...(result.document.more ?? []).map(next => next.item)].map(item => item.item_id);
  for (const id of [shared[0], three, four]) {
    const folder = `${box.seats.actor.path}-item-${id}`;
    assert.match(box.git(folder, 'rev-parse', '--show-toplevel').trim(), new RegExp(`item-${id}$`, 'u'), 'its own item folder is open');
    assert.ok(result.out.includes(folder), `the output names ${folder}`);
    assert.ok(printed.includes(id), `the output names #${id}: ${printed.join(', ')}`);
  }
  assert.equal(result.out.split('The real fixture succeeds.').length - 1 >= 3, true, 'each bar is printed');
});

test('clause 3: with N=1, next claims one item exactly as before [C7]', async t => {
  const box = await fixture(t);
  const [one, , three] = fourItems(box);
  setN(box, 1);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const status = id => box.board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status;
  assert.equal(status(one), 'claimed');
  assert.equal(status(three), 'open', 'no second claim at N=1');
});

/** Ids of the build claims the seat holds now. */
function heldBy(box, seat) {
  return box.board.db.prepare("SELECT item_id FROM item WHERE item_status='claimed' AND item_owner=? ORDER BY item_id").all(seat.id).map(row => row.item_id);
}

/** Add n ready items, each in a file of its own. */
function alone(box, n) {
  return Array.from({ length: n }, (_, index) => box.add(`Alone ${index}`, { brief: `Files: web/alone-${index}.js\nTest: the real board selects the eligible item.` }));
}

test('clause 1: with N=5, next tops the seat up to five claims with no other cap, prints each id, and each claim records the N it used [C7]', async t => {
  const box = await fixture(t);
  alone(box, 6);
  setN(box, 5);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const held = heldBy(box, box.seats.actor);
  assert.equal(held.length, 5, `the seat holds N=5: ${held.join(', ')}`);
  const printed = [result.document.item, ...(result.document.more ?? []).map(next => next.item)].map(item => item.item_id).sort((a, b) => a - b);
  assert.deepEqual(printed, held, 'the document names every claim');
  for (const next of result.document.more) assert.ok(next.itemFolder.endsWith(`-item-${next.item.item_id}`), `#${next.item.item_id} names its folder`);
  const recorded = held.map(id => JSON.parse(box.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='claim' AND item_id=?").get(id).event_detail).claimsPerSeat);
  assert.deepEqual(recorded, [5, 5, 5, 5, 5], 'each claim records N, so a replay reads the same number');
});

test('clause 1: a seat already holding one item is topped up to three by next [C7]', async t => {
  const box = await fixture(t);
  const [first] = alone(box, 4);
  setN(box, 3);
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(first)]);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const held = heldBy(box, box.seats.actor);
  assert.equal(held.length, 3, `the seat holds three: ${held.join(', ')}\n${result.out}`);
  assert.ok(held.includes(first), 'the first claim is kept');
});

test('clause 2: submit names the next held item and claims exactly one more below N [C7]', async t => {
  const files = { 'web/value.js': 'export const value = 0;\n', 'package.json': '{"type":"module"}\n',
    'web/handoff.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('the submitted value is repaired', () => assert.equal(readFileSync(new URL('./value.js', import.meta.url), 'utf8'), 'export const value = 1;\\n'));
` };
  const box = await fixture(t, { files });
  const seat = box.seats.actor;
  setN(box, 3);
  const check = `env -u NODE_TEST_CONTEXT "${process.execPath}" --test --test-reporter=tap web/handoff.test.js`;
  const first = box.add('Repair the value', { check, brief: 'Files: web/value.js\nTest: the value is repaired.' });
  const [second, third, fourth] = alone(box, 3);
  for (const id of [first, second]) {
    const claimed = await cli(box, seat.path, ['claim', String(id)]);
    assert.equal(claimed.code, 0, claimed.out + claimed.err);
  }
  const folder = `${seat.path}-item-${first}`;
  writeFileSync(join(folder, 'web/value.js'), 'export const value = 1;\n');
  box.git(folder, 'add', 'web/value.js');
  box.git(folder, 'commit', '-q', '-m', 'fix(web): repair the fixture value [G1]');
  const result = await cli(box, folder, ['submit', String(first)]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.document.next.item.item_id, second, 'submit names the held item');
  assert.equal(result.document.next.held, true);
  const more = (result.document.next.more ?? []).map(next => next.item.item_id);
  assert.equal(more.length, 1, `exactly one more: ${more.join(', ')}`);
  assert.ok([third, fourth].includes(more[0]));
  // The submitted item keeps its claim while its pulled gate runs, so the seat holds it, the named item and one more.
  assert.deepEqual(heldBy(box, seat), [first, second, more[0]].sort((a, b) => a - b), 'the seat holds the submitted item, the named item and one more');
});

test('clause 3: with claims.perSeat 1, next claims exactly one item and records N=1 [C7]', async t => {
  const box = await fixture(t);
  alone(box, 3);
  setN(box, 1);
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  const held = heldBy(box, box.seats.actor);
  assert.equal(held.length, 1, `one claim at N=1: ${held.join(', ')}`);
  assert.equal(result.document.more, undefined, 'no extra claims are named');
  assert.doesNotMatch(result.out, /you hold #/u);
  assert.equal(JSON.parse(box.board.db.prepare("SELECT event_detail FROM event WHERE event_kind='claim' AND item_id=?").get(held[0]).event_detail).claimsPerSeat, 1);
});
