/** `next` leads with its answer and keeps held queues readable [N2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { main } from './native-cli-fixture.js';
import { fixture } from './next-take-fixture.js';

test('no-item answer comes first and fifty held items fit in a short response [N2,C7]', async t => {
  const box = await fixture(t);
  for (let index = 0; index < 50; index++) {
    const id = box.add(`Held item ${index + 1}`);
    store.holdItem(box.board, id, { agentId: 'coordinator', reason: `fixture hold ${index + 1}` });
  }

  let out = '', err = '';
  const code = await main(['next'], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  const answer = `${out}${err}`;
  const first = answer.split(/\r?\n/u, 1)[0];

  assert.equal(code, 1);
  assert.match(first, /^pullboard: \[NOTHING_FREE\].*no item is free/u);
  assert.match(first, /50 items are held by coordinator/u);
  assert.doesNotMatch(first, /#\d+ is held by coordinator:/u);
  assert.ok(Buffer.byteLength(answer) < 2048, `response was ${Buffer.byteLength(answer)} bytes`);
});
