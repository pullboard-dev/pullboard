/** An older-engine reader meeting a newer relay move stops with an upgrade next step and leaves the journal intact [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal } from '../../../packages/kernel/index.js';
import { syncRelay } from '../../../packages/link/index.js';
import { ENGINE_VERSION } from '../../../packages/state/index.js';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';
import { closeCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';

/** Read the relay's whole ordered journal as the client would, as one comparable string. */
async function journal(box, link) {
  const response = await fetch(`${box.origin}/api/v1/boards/${link.board}/events?after=0`, {
    headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  return JSON.stringify(await response.json());
}

/** Link a board, append one move sealed one engine ahead of this reader, and sync it as the reader would. */
async function meetNewerMove(t) {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  await box.link();
  const link = box.readLink();
  const future = { version: 1, engine: ENGINE_VERSION + 1, id: 'future-engine-record', operation: 'futureOperation', args: [] };
  const sequence = link.sequence + 1;
  const sealed = Buffer.from(await seal(Buffer.from(box.readKey(), 'base64url'), new TextEncoder().encode(JSON.stringify(future)), { boardId: link.board, kind: 'move', sequence })).toString('base64url');
  const sent = await fetch(`${box.origin}/api/v1/boards/${link.board}/moves`, {
    method: 'POST', body: JSON.stringify({ sequence, sealed }),
    headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const appended = await journal(box, link);
  const lines = [];
  const summary = await syncRelay(box.root, { ...box.io, err: (line) => lines.push(String(line)) });
  return { box, link, appended, lines, summary, sequence };
}

test('relay.engine-newer-move.a-reader-whose-engine-is-older: clause 1: a reader whose engine is older than a relay move stops with ENGINE_VERSION and an upgrade next step [C7,H16]', async (t) => {
  const { lines, summary, link } = await meetNewerMove(t);
  assert.equal(summary.health.code, 'ENGINE_VERSION', 'the reader stops on the engine refusal');
  assert.equal(summary.sequence, link.sequence, 'the reader applied nothing past the newer move');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`\\[ENGINE_VERSION\\] move engine version ${ENGINE_VERSION + 1} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard`));
});

test("relay.engine-newer-move.the-relay-s-journal-is-unchanged: clause 2: the relay's journal is unchanged after the reader stops [C7,H16]", async (t) => {
  const { box, link, appended } = await meetNewerMove(t);
  assert.equal(await journal(box, link), appended, 'the stop leaves every journal record as the relay stored it');
});
