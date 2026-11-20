/** route reservations are on with no setting, and off only when set false [C7,#11306]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { getItem } from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Write this fixture machine's settings, keeping its quiet fields; `route` is added only when given. */
function settings(route) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, ...(route ? { route } : {}) }));
}

test('cli.journeys-next-reservations-default.reservations-on-with-no-setting: with no route.reservations setting, route --to reserves and next skips the item for another seat naming the holder; set off, route --to is refused and next offers the item [C7,#11306]', async t => {
  const box = await fixture(t);
  settings(null);
  const id = box.add('Reserved by default');
  const reserve = await cli(box, box.root, ['route', String(id), '--to', 'web-7']);
  assert.equal(reserve.code, 0, reserve.out + reserve.err);
  assert.equal(getItem(box.board, id).item_reservation_holder, 'web-7');
  const skipped = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.notEqual(skipped.code, 0, skipped.out);
  assert.match(skipped.out + skipped.err, new RegExp(`#${id} is reserved for web-7`, 'u'));

  const other = await fixture(t);
  settings({ reservations: false });
  const free = other.add('Reservations set off');
  const refused = await cli(other, other.root, ['route', String(free), '--to', 'web-7']);
  assert.equal(refused.document?.error?.code, 'SETTING_OFF', refused.out + refused.err);
  assert.match(refused.document.error.next, /route\.reservations/u);
  assert.equal(getItem(other.board, free).item_reservation_holder ?? null, null);
  const offered = await cli(other, other.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, free);
});
