/** A claim records a five-part checkpoint fact when seat.checkpoints is on, and writes nothing more when it is off [C7,#8549]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKPOINT_PARTS } from '../../../../packages/seats/index.js';
import { readCheckpoint } from '../../../../packages/seats/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** Claim a fresh item as a seat through the real command, and return the item's id and fact texts. */
async function claimed(box, seat, title) {
  const id = box.add(title);
  const taken = await cli(box, seat.path, ['claim', String(id)]);
  assert.equal(taken.code, 0, taken.out + taken.err);
  return { id, err: taken.err, facts: itemThread(box.board, id).filter(row => row.type === 'fact').map(row => row.text) };
}

/** Switch seat.checkpoints off in one seat's own checkout, as a project that never sets it would have it. */
function switchOff(seat) {
  const file = join(seat.path, 'pullboard.json');
  const { seat: ignored, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(rest));
}

test('clause 1: a claim records one checkpoint fact with the five parts when seat.checkpoints is on [C7,#8549]', async t => {
  const box = await fixture(t, { settings: { seat: { checkpoints: true } } });
  const { id, facts, err } = await claimed(box, box.seats.builder, 'Checkpointed claim');
  const found = facts.map(readCheckpoint).filter(Boolean);
  assert.equal(found.length, 1, `exactly one checkpoint fact: ${err}`);
  assert.equal(found[0].moment, 'claim');
  assert.deepEqual(Object.keys(found[0].fact), CHECKPOINT_PARTS);
  assert.deepEqual(found[0].fact.left, [`build #${id}: Checkpointed claim`], 'what is left names the item');
});

test('clause 1: a claim adds no checkpoint fact and no other fact when seat.checkpoints is off or never set [C7,#8549]', async t => {
  const box = await fixture(t, { settings: { seat: { checkpoints: true } } });
  const on = await claimed(box, box.seats.builder, 'Claimed with the setting on');
  switchOff(box.seats.actor);
  const off = await claimed(box, box.seats.actor, 'Claimed with the setting never set');
  assert.equal(off.facts.filter(readCheckpoint).length, 0, 'no checkpoint fact');
  assert.equal(off.facts.length, on.facts.length - 1, 'the checkpoint is the only fact the setting adds');
});
