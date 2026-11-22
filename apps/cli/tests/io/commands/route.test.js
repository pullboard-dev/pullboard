/** `route <id> --to <seat>` and `route <id> --off` record and clear a reservation behind route.reservations [C7,#9160]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** Write the fixture machine's settings with route.reservations as given, keeping the fixture's own quiet fields. */
function reservations(on) {
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, route: { reservations: on } }));
}

/** Write this fixture machine's settings, keeping its quiet fields; `route` is added only when given. */
function settings(route) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, ...(route ? { route } : {}) }));
}

/** The refusal code a CLI run printed, or null when it exited 0. */
const refusal = result => (result.code === 0 ? null : result.document?.error?.code ?? `exit ${result.code}: ${result.out}${result.err}`);

test('cli.io-commands-route.to-reserves: clause 1: with route.reservations on, route <id> --to <seat> records the reservation through reserveItem and the item reads as reserved for that seat [C7,#9160]', async t => {
  const box = await fixture(t);
  reservations(true);
  const id = box.add('Reserve me');
  const done = await cli(box, box.root, ['route', String(id), '--to', 'builder-seat']);
  assert.equal(refusal(done), null, done.out + done.err);
  assert.equal(store.getItem(box.board, id).item_reservation_holder, 'builder-seat');
});

test('cli.io-commands-route.off-clears: clause 2: with route.reservations on, route <id> --off clears the reservation through clearReservation and the item reads as unreserved [C7,#9160]', async t => {
  const box = await fixture(t);
  reservations(true);
  const id = box.add('Reserve then clear');
  assert.equal(refusal(await cli(box, box.root, ['route', String(id), '--to', 'builder-seat'])), null);
  const done = await cli(box, box.root, ['route', String(id), '--off']);
  assert.equal(refusal(done), null, done.out + done.err);
  assert.equal(store.getItem(box.board, id).item_reservation_holder, null);
});

test('cli.io-commands-route.off-by-default-refused: clause 3: with route.reservations off, route --to and route --off are refused SETTING_OFF with a next step, nothing is written, and --suggest still runs [C7,#9160]', async t => {
  const box = await fixture(t);
  reservations(false);
  const id = box.add('Stay unreserved');
  const to = await cli(box, box.root, ['route', String(id), '--to', 'builder-seat']);
  assert.equal(refusal(to), 'SETTING_OFF', to.out + to.err);
  assert.match(to.document.error.next, /route\.reservations/u);
  const off = await cli(box, box.root, ['route', String(id), '--off']);
  assert.equal(refusal(off), 'SETTING_OFF', off.out + off.err);
  assert.equal(store.getItem(box.board, id).item_reservation_holder ?? null, null);
  const suggest = await cli(box, box.root, ['route', '--suggest']);
  assert.equal(refusal(suggest), null, suggest.out + suggest.err);
});

test('cli.journeys-next-reservations-default.reservations-on-with-no-setting: with no route.reservations setting, route --to reserves and next skips the item for another seat naming the holder; set off, route --to is refused and next offers the item [C7,#11306]', async t => {
  const box = await fixture(t);
  settings(null);
  const id = box.add('Reserved by default');
  const reserve = await cli(box, box.root, ['route', String(id), '--to', 'web-7']);
  assert.equal(reserve.code, 0, reserve.out + reserve.err);
  assert.equal(store.getItem(box.board, id).item_reservation_holder, 'web-7');
  const skipped = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.notEqual(skipped.code, 0, skipped.out);
  assert.match(skipped.out + skipped.err, new RegExp(`#${id} is reserved for web-7`, 'u'));

  const other = await fixture(t);
  settings({ reservations: false });
  const free = other.add('Reservations set off');
  const refused = await cli(other, other.root, ['route', String(free), '--to', 'web-7']);
  assert.equal(refused.document?.error?.code, 'SETTING_OFF', refused.out + refused.err);
  assert.match(refused.document.error.next, /route\.reservations/u);
  assert.equal(store.getItem(other.board, free).item_reservation_holder ?? null, null);
  const offered = await cli(other, other.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, free);
});
