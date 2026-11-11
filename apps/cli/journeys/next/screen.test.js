/** `next --take` keeps a claim and its one action on the first screen, however long the hold list [C7,#2895]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Capture the native CLI's human answer without changing its board or environment contract. */
async function answer(box, args) {
  let out = '', err = '';
  const code = await main(args, { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

test('a claim names the item and its submit action in the first 3 lines, with no --wait [C7,#2895]', async t => {
  const box = await fixture(t);
  for (let index = 0; index < 50; index++) {
    store.holdItem(box.board, box.add(`Held item ${index + 1}`), { agentId: 'coordinator', reason: `fixture hold ${index + 1}` });
  }
  const ready = box.add('Ready item to claim');

  const result = await answer(box, ['next', '--take']);
  const lines = result.text.split(/\r?\n/u);

  assert.equal(result.code, 0, result.text);
  assert.match(lines[0], new RegExp(`^claimed #${ready}: Ready item to claim$`, 'u'));
  assert.ok(lines.slice(0, 3).some(line => line.startsWith('next: ') && line.includes(`pullboard submit ${ready}`)), lines.slice(0, 3).join('\n'));
  assert.doesNotMatch(result.text, /--wait/u);
});

test('a claim folds held items into one count line and stays short [C7,#2895]', async t => {
  const box = await fixture(t);
  for (let index = 0; index < 50; index++) {
    store.holdItem(box.board, box.add(`Held item ${index + 1}`), { agentId: 'coordinator', reason: `fixture hold ${index + 1}` });
  }
  box.add('Ready item to claim');

  const result = await answer(box, ['next', '--take']);

  assert.equal(result.code, 0, result.text);
  assert.doesNotMatch(result.text, /#\d+ is held by coordinator:/u);
  assert.match(result.text, /50 items are held by coordinator/u);
  assert.ok(Buffer.byteLength(result.text) < 4096, `response was ${Buffer.byteLength(result.text)} bytes`);
});
