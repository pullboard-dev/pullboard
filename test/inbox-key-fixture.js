/** A real relay inbox read must not turn an unavailable key into a forged receipt [E9,E18,N26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openBoardForRead } from '../src/board.js';

/** Observe only the private fixture's canonical delivery projection. */
function receipts(box) {
  const board = openBoardForRead(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { return board.db.prepare("SELECT * FROM board_meta WHERE meta_key LIKE 'activity:%' ORDER BY meta_key").all(); }
  finally { board.db.close(); }
}

/** Observe the inbox's separate unread projection, which must not consume an unrecorded interrupt. */
function shoutCursors(box) {
  const board = openBoardForRead(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { return board.db.prepare('SELECT agent_id, agent_last_shout_id FROM agent ORDER BY agent_id').all(); }
  finally { board.db.close(); }
}

/** Read an optional local cursor without creating it. */
function cursor(box) {
  const file = join(box.root, '.git', 'pullboard-activity.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Seed ordinary native decision records before relay linking; the real snapshot then carries their history. */
export async function prepareKeylessInbox(box) {
  const result = await box.script(`
    import * as store from ${JSON.stringify(new URL('../src/board.js', import.meta.url).href)};
    import { join } from 'node:path';
    const board = store.openBoard(join(process.cwd(), '.git', 'pullboard', 'board.sqlite'));
    try {
      const question = store.shout(board, { from: 'coordinator', to: 'person',
        text: 'May this session read without recording delivery?', decision: true, lanes: [${JSON.stringify(box.lane)}] });
      const answer = store.answerDecision(board, question, { agentId: 'coordinator', asPerson: true, channel: 'terminal',
        text: 'Read without acknowledging until the key returns.', lanes: [${JSON.stringify(box.lane)}] });
      console.log(JSON.stringify({ answer }));
    } finally { store.closeBoard(board); }
  `);
  assert.equal(result.code, 0, `native fixture setup: ${result.failure}`);
  return result.document;
}

/** Preserve both cursors while displaying a real obligation and refusing explicit acknowledgement. */
export async function readKeylessInbox(box, state) {
  const beforeCursor = cursor(box), beforeReceipts = receipts(box);
  const beforeShouts = shoutCursors(box);
  const read = await box.cli('inbox');
  assert.equal(read.code, 0, `inbox reads without the key: ${JSON.stringify(read.document?.error ?? null)}`);
  assert.equal(read.document.activity.receipt.recorded, false, 'an unavailable canonical receipt is never claimed');
  assert.equal(read.document.activity.receipt.code, 'RELAY_KEY_MISSING', 'delivery reports why it remains unrecorded');
  const interrupt = read.document.activity.interrupts.find(entry => entry.shout === state.answer);
  assert.ok(interrupt, 'the answered decision remains visible despite the missing key');
  state.interrupt = interrupt.id;
  assert.equal(cursor(box), beforeCursor, 'unrecorded delivery never advances the local cursor');
  assert.deepEqual(receipts(box), beforeReceipts, 'the read cannot forge a canonical delivery');
  assert.deepEqual(shoutCursors(box), beforeShouts, 'an unrecorded read cannot consume its answer through the unread projection');
  const acted = await box.cli('inbox', '--acted-on', state.interrupt);
  assert.equal(acted.document?.error?.code, 'RELAY_KEY_MISSING', 'explicit acknowledgement stays an authenticated write');
  assert.deepEqual(receipts(box), beforeReceipts, 'a refused acknowledgement changes no receipt');
  return read;
}

/** Restored credentials deliver the same obligation, which disappears only after explicit acknowledgement. */
export async function finishKeylessInbox(box, state) {
  const delivered = await box.cli('inbox');
  assert.equal(delivered.code, 0, 'restoring the key permits canonical delivery');
  assert.notEqual(delivered.document.activity.receipt?.recorded, false, 'delivery is recorded rather than silently skipped');
  assert.ok(delivered.document.activity.interrupts.some(entry => entry.id === state.interrupt), 'the unrecorded obligation survives key recovery');
  assert.notEqual(cursor(box), null, 'only successful delivery advances the local cursor');
  assert.ok(receipts(box).some(row => row.meta_key.endsWith(`pending:${state.interrupt}`)), 'the native board retains the delivered obligation');
  const acted = await box.cli('inbox', '--acted-on', state.interrupt);
  assert.equal(acted.code, 0, 'the recipient can acknowledge after credentials return');
  assert.equal(acted.document.activity.interrupts.some(entry => entry.id === state.interrupt), false, 'explicit acknowledgement retires only the delivered obligation');
}
