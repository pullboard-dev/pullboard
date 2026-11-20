/** The release-twice reroute with release.rerouteUntouched on: two untouched INELIGIBLE hand-backs from next move the item one route up, as an escalate event naming both [C7,#2970]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Take the item from next as `seat` and hand it back untouched with INELIGIBLE, through the real commands. */
async function handBack(box, seat, id) {
  const taken = await cli(box, seat.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, id, 'the seat was handed the item straight from next');
  const released = await cli(box, seat.path, ['release', String(id), '--reason', 'INELIGIBLE', '--note', 'cannot be built as written']);
  assert.equal(released.code, 0, released.out + released.err);
  box.advance(31 * 60_000);
}

test('cli.journeys-release-reroute.with-release-rerouteuntouched-on-two-untouched: clause 1: with release.rerouteUntouched on, two untouched INELIGIBLE releases reroute the item one route up with no coordinator edit [C7,#2970]', async t => {
  const box = await fixture(t, { route: 'mid' });
  const settings = machineSettingsFile();
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), release: { rerouteUntouched: true } }));
  const id = box.add('Item two seats hand back untouched', { route: 'mid' });
  await handBack(box, box.seats.actor, id);
  assert.equal(store.getItem(box.board, id).item_route, 'mid', 'one untouched release leaves the route');
  await handBack(box, box.seats.builder, id);
  const item = store.getItem(box.board, id);
  assert.equal(item.item_route, 'strong', 'the second untouched release moves the item one route up');
  assert.equal(item.item_status, 'open');
  assert.equal(store.events(box.board, { itemId: id }).some(event => event.event_kind === 'edit'), false, 'no coordinator edit moved it');
});

test('cli.journeys-release-reroute.the-reroute-is-an-escalate-event: clause 2: the reroute is an escalate event naming both releases [C7,#2970]', async t => {
  const box = await fixture(t, { route: 'mid' });
  const settings = machineSettingsFile();
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), release: { rerouteUntouched: true } }));
  const id = box.add('Item two seats hand back untouched', { route: 'mid' });
  await handBack(box, box.seats.actor, id);
  await handBack(box, box.seats.builder, id);
  const escalations = store.events(box.board, { itemId: id }).filter(event => event.event_kind === 'escalate');
  assert.equal(escalations.length, 1, 'one escalate event records the reroute');
  const detail = JSON.parse(escalations[0].event_detail);
  assert.deepEqual([detail.from, detail.to], ['mid', 'strong']);
  assert.ok(detail.note.includes(box.seats.actor.id) && detail.note.includes(box.seats.builder.id), 'the note names both releases by their seats: ' + detail.note);
  assert.equal((detail.note.match(/INELIGIBLE/gu) ?? []).length, 2, 'and both reasons');
});
