/** A seat inside its --wait keeps looking through lost claim races and is handed the item once free [N2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../../../../../packages/store/index.js';
import { release } from '../../../../../packages/store/index.js';
import { nextProgress } from '../../../../../packages/sandbox/index.js';
import { fixture } from './take.js';

/** Turn a real native claim attempt into the retry metadata the next command keeps. */
function attempt(box, item) {
  try { box.claim(item, box.seats.actor); return { item: getItem(box.board, item) }; }
  catch (error) {
    return { retry: true, retryDetail: { phase: 'claim', item, code: error.code, message: error.message } };
  }
}

test('next --wait rests after repeated lost claim races instead of exiting NEXT_TIMEOUT, then gets the item [N2,C7]', async t => {
  const box = await fixture(t);
  const pinned = box.add('A pinned item every seat wants');
  box.claim(pinned, box.seats.builder);
  const progress = nextProgress({ stderr: { write() {} } }, { maxRetries: 16 });
  t.after(progress.stop);
  const until = Date.now() + 60_000;
  let attempts = 0, found;
  for (;;) {
    attempts++;
    // The peer holds the item for the first four looks, a pause longer than three unchanged refusals.
    if (attempts === 5) release(box.board, pinned, box.seats.builder.id, 'The peer returns the item', 'OTHER');
    found = await progress.run('claim', pinned, () => attempt(box, pinned));
    if (!found.retry) break;
    await progress.retry(found, { until, rest: 1 });
  }
  assert.equal(attempts, 5, 'the seat looked again after the third unchanged refusal');
  assert.equal(found.item.item_owner, box.seats.actor.id, 'the freed item is given to the waiting seat');
});

test('next --wait still exits NEXT_TIMEOUT once its wait has run out [N2,C7]', async t => {
  const box = await fixture(t);
  const pinned = box.add('A pinned item held for the whole wait');
  box.claim(pinned, box.seats.builder);
  const progress = nextProgress({ stderr: { write() {} } });
  t.after(progress.stop);
  await assert.rejects(async () => {
    for (;;) {
      const found = await progress.run('claim', pinned, () => attempt(box, pinned));
      await progress.retry(found, { until: Date.now() - 1, rest: 1 });
    }
  }, error => error.code === 'NEXT_TIMEOUT' && error.message.includes(`#${pinned}`));
});
