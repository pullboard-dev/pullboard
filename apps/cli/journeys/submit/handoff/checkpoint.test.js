/** A handoff records a five-part checkpoint fact when seat.checkpoints is on, and nothing more when it is off [C7,#8552]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKPOINT_PARTS } from '../../../../../packages/seats/index.js';
import { readCheckpoint } from '../../../../../packages/seats/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../../tests/fixtures/next/take.js';

/** Hold one claim on the builder seat, hand off from it, and return the hand-off item's fact texts. */
async function handoffFacts(t, projectConfig) {
  const box = await fixture(t, { projectConfig });
  const held = box.add('Held while handing off');
  box.claim(held, box.seats.builder);
  const opened = await cli(box, box.seats.builder.path, ['handoff']);
  assert.equal(opened.code, 0, opened.out + opened.err);
  const facts = itemThread(box.board, opened.document.handoff.item).filter(row => row.type === 'fact').map(row => row.text);
  return { held, facts };
}

test('clause 1: a handoff records one checkpoint fact with the five parts when seat.checkpoints is on [C7,#8552]', async t => {
  const { held, facts } = await handoffFacts(t, { seat: { checkpoints: true } });
  const found = facts.map(readCheckpoint).filter(Boolean);
  assert.equal(found.length, 1, 'exactly one checkpoint fact');
  assert.equal(found[0].moment, 'handoff');
  assert.deepEqual(Object.keys(found[0].fact), CHECKPOINT_PARTS);
  assert.deepEqual(found[0].fact.left, [`#${held} Held while handing off`], 'what is left names the held claim');
  assert.match(found[0].fact.evidence[0], /^worktree .+ on /u, 'evidence names the worktree');
});

test('clause 1: a handoff adds no checkpoint fact and no other fact when seat.checkpoints is off or never set [C7,#8552]', async t => {
  const on = await handoffFacts(t, { seat: { checkpoints: true } });
  for (const settings of [{ seat: { checkpoints: false } }, {}]) {
    const off = await handoffFacts(t, settings);
    assert.equal(off.facts.filter(readCheckpoint).length, 0, `no checkpoint fact for ${JSON.stringify(settings)}`);
    assert.equal(off.facts.length, on.facts.length - 1, 'the checkpoint is the only fact the setting adds');
  }
});
