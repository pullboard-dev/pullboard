/** `route <id> --to <seat>` and `route <id> --off` record and clear a reservation behind route.reservations [C7,#9160]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import * as store from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

/** Write the fixture machine's settings with route.reservations as given, keeping the fixture's own quiet fields. */
function reservations(on) {
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, route: { reservations: on } }));
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
