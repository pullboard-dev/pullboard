/** show prints who holds an item reservation, behind route.reservations [C7,#9178]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { getItem } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { release } from '../../../../packages/store/index.js';
import { reserveItem } from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Turn route.reservations on or off for this fixture's machine, keeping the settings the fixture wrote. */
function reservations(on) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, route: { reservations: on } }));
}

/** A reserved item and an unreserved one, with the setting as asked; returns what show printed for each. */
async function shown(t, on) {
  const box = await fixture(t);
  const reserved = box.add('Reserved item', { brief: 'Files: web/reserved.js' });
  const plain = box.add('Unreserved item', { brief: 'Files: web/plain.js' });
  reserveItem(box.board, reserved, { agentId: 'coordinator', holder: 'web-7' });
  reservations(on);
  const print = async id => {
    let out = '';
    const stdout = { isTTY: false, write: part => { out += part; } };
    const code = await main(['show', String(id)], { cwd: box.root, clock: box.clock, stdout, stderr: stdout });
    assert.equal(code, 0, out);
    return out;
  };
  return { reserved: await print(reserved), plain: await print(plain) };
}

test('cli.journeys-next-reservations.with-route-reservations-on-show-prints-the-holder: clause 1: with route.reservations on, show prints the reservation holder on a reserved item and no reservation line on an unreserved one [C7,#9178]', async t => {
  const { reserved, plain } = await shown(t, true);
  assert.match(reserved, /reserved for web-7 by coordinator/u);
  assert.doesNotMatch(plain, /reserved for/u);
});

test('cli.journeys-next-reservations.with-route-reservations-off-show-prints-nothing-new: clause 2: with route.reservations off, show prints no reservation line on a reserved item [C7,#9178]', async t => {
  const { reserved } = await shown(t, false);
  assert.doesNotMatch(reserved, /reserved for/u);
});

/** One item reserved for `holder` ('actor' stands for the building seat itself), the setting as asked, then one next --take by that seat. */
async function taken(t, on, holder) {
  const box = await fixture(t);
  const id = box.add('Reserved item');
  reserveItem(box.board, id, { agentId: 'coordinator', holder: holder === 'actor' ? box.seats.actor.id : holder });
  reservations(on);
  return { id, result: await cli(box, box.seats.actor.path, ['next', '--take']) };
}

test('cli.journeys-next-reservations.next-skips-an-item-reserved-for-another-seat: clause 1: with route.reservations on, next --take skips an item reserved for another seat and names the holder, and offers it to the holder [C7,#9161]', async t => {
  const other = await taken(t, true, 'web-7');
  assert.notEqual(other.result.code, 0, other.result.out);
  assert.match(other.result.out + other.result.err, new RegExp(`#${other.id} is reserved for web-7`, 'u'));
  const own = await taken(t, true, 'actor');
  assert.equal(own.result.code, 0, own.result.out + own.result.err);
  assert.equal(own.result.document.item.item_id, own.id);
});

test('cli.journeys-next-reservations.with-route-reservations-off-next-ignores-a-reservation: clause 2: with route.reservations off, next --take offers a reserved item exactly as without a reservation [C7,#9161]', async t => {
  const off = await taken(t, false, 'web-7');
  assert.equal(off.result.code, 0, off.result.out + off.result.err);
  assert.equal(off.result.document.item.item_id, off.id);
});

/** An item its builder holds and the coordinator reserved for that builder, the setting as asked. */
function reservedClaim(box, on) {
  const id = box.add('Reserved claim');
  box.claim(id);
  reserveItem(box.board, id, { agentId: 'coordinator', holder: box.seats.builder.id });
  reservations(on);
  return id;
}

test('cli.journeys-next-reservations.release-and-land-end-a-reservation: clause 1: with route.reservations on, the holder releasing the item and the item landing each clear its reservation, so next offers the item to every seat [C7,#9162]', async t => {
  const box = await fixture(t);
  const id = reservedClaim(box, true);
  release(box.board, id, box.seats.builder.id, 'Return the fixture claim', undefined, 'OTHER');
  assert.equal(getItem(box.board, id).item_reservation_holder, null);
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, id);
  const landing = box.add('Reserved landing');
  reserveItem(box.board, landing, { agentId: 'coordinator', holder: 'web-7' });
  merged(box.board, landing, { agentId: 'coordinator', commit: 'a'.repeat(40), forced: 'Fixture landing', waiveProof: 'Fixture has no receipt' });
  assert.equal(getItem(box.board, landing).item_reservation_holder, null);
});

test('cli.journeys-next-reservations.with-route-reservations-off-release-and-land-keep-a-reservation: clause 2: with route.reservations off, release and landing leave a reservation exactly as on main [C7,#9162]', async t => {
  const box = await fixture(t);
  const id = reservedClaim(box, false);
  release(box.board, id, box.seats.builder.id, 'Return the fixture claim', undefined, 'OTHER');
  assert.equal(getItem(box.board, id).item_reservation_holder, box.seats.builder.id);
  const landing = box.add('Reserved landing');
  reserveItem(box.board, landing, { agentId: 'coordinator', holder: 'web-7' });
  merged(box.board, landing, { agentId: 'coordinator', commit: 'a'.repeat(40), forced: 'Fixture landing', waiveProof: 'Fixture has no receipt' });
  assert.equal(getItem(box.board, landing).item_reservation_holder, 'web-7');
});
