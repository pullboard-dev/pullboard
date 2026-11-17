/** @pullboard-test-input source-cell shouts */
/** With watch.quietReads on, a busy second of board events costs one read of main's head, and a later main move still prints [C7,#9843]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openKitBoard } from '../../tests/fixtures/board.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { followBoard } from '../../../../packages/shouts/index.js';
import { watchOptions } from '../../../../packages/shouts/index.js';
import { watchStart } from '../../../../packages/shouts/index.js';

const BURST = 20;
const START = 1800000000;

/** Insert merged events with the given ids' worth of rows, one per second from START. */
function seedEvents(path, from, to) {
  const board = openKitBoard(path);
  try {
    for (let i = from; i <= to; i += 1) {
      board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'merged', NULL, '{}')")
        .run(new Date((START + i) * 1000).toISOString());
    }
    return board.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  } finally { closeBoard(board); }
}

/**
 * Follow a board's stream with a fake clock and a counting head reader: BURST events arrive at one instant, then the
 * head moves, the clock passes a second and one more event arrives.
 *
 * @returns {Promise<{ reads: number, events: number, lines: string[] }>}
 */
async function follow(t, quietReads) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const burst = seedEvents(file, 1, BURST);
  const later = seedEvents(file, BURST + 1, BURST + 1).at(-1);
  const burstDone = Promise.withResolvers();
  const lines = [];
  const waiting = [];
  let clock = 1_000_000;
  let head = 'aaa';
  let reads = 0;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of burst) response.write(`event: board\ndata: ${JSON.stringify({ event })}\n\n`);
    waiting.push(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const response of waiting) response.destroy(); server.closeAllConnections(); server.close(); });
  const abort = new AbortController();
  const mainMoved = Promise.withResolvers();
  const start = watchStart(file);
  const options = { ...watchOptions({ work: 'core' }, { config: { lanes: { core: {} } }, agents: start.agents }), since: 0 };
  const port = server.address().port;
  const done = followBoard({
    file, mainRoot: box.repo, commonDir: box.repo, config: { lanes: { core: {} } }, isMain: true,
    runCommand: () => assert.fail('a view is running, so no private API is needed'), serveApi: () => assert.fail('no private API'),
    refusalDocument: () => ({}), boardOpeners: {}, viewPorts: {}, options, start, signal: abort.signal,
    runningView: async () => ({ url: `http://127.0.0.1:${port}/?k=secret`, port }),
    now: () => clock, quietReads, readHead: async () => { reads += 1; return head; },
    write: (text) => {
      lines.push(text);
      if (text.startsWith(`${burst.at(-1).event_id} `)) burstDone.resolve();
      if (/main moved to bbb/u.test(text)) mainMoved.resolve();
    },
    note: () => {},
  });
  await burstDone.promise;
  head = 'bbb';
  clock += 1500;
  for (const response of waiting) response.write(`event: board\ndata: ${JSON.stringify({ event: later })}\n\n`);
  await mainMoved.promise;
  abort.abort();
  assert.equal(await done, 0);
  return { reads, events: burst.length, lines };
}

test('clause 1: with watch.quietReads on, 20 board events inside one second make followBoard read main\'s head once, and a main move after that second is still printed as a main line [C7,#9843]', async (t) => {
  const { reads, events, lines } = await follow(t, true);
  assert.ok(events >= BURST, 'the burst holds at least 20 events');
  assert.equal(reads, 2, 'the whole burst shares the one read made at the start, and the event after the second reads the head again');
  assert.equal(lines.filter(line => /main moved to bbb/u.test(line)).length, 1);
});

test('clause 2: with watch.quietReads off the head is read after every event as today [C7,#9843]', async (t) => {
  const { reads, events } = await follow(t, false);
  assert.ok(events >= BURST, 'the burst holds at least 20 events');
  assert.equal(reads, events + 2, 'one read at the start and one per event, the burst and the later one');
});
