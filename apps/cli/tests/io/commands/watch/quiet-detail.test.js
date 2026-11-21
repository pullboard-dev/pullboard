/** @pullboard-test-input source-cell shouts */
/** With watch.quietReads on, an event the --kinds or --item filter drops is not looked up for detail, and printed lines never change [C7,#9844]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { openKitBoard } from '../../../fixtures/board.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import { followBoard } from '../../../../../../packages/shouts/index.js';
import { watchOptions } from '../../../../../../packages/shouts/index.js';
import { watchStart } from '../../../../../../packages/shouts/index.js';

const COUNT = 50;
const START = 1800000000;

/** Insert COUNT merged events one second apart and return every event row. */
function seedEvents(path) {
  const board = openKitBoard(path);
  try {
    for (let i = 1; i <= COUNT; i += 1) {
      board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'merged', NULL, '{}')")
        .run(new Date((START + i) * 1000).toISOString());
    }
    return board.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  } finally { closeBoard(board); }
}

/**
 * Follow a stream of the seeded events with the given flags and count the detail lookups.
 *
 * @returns {Promise<{ lookups: number, lines: string[] }>}
 */
async function follow(t, quietReads, values) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const events = seedEvents(file);
  const last = events.at(-1).event_id;
  const drained = Promise.withResolvers();
  const lines = [];
  let lookups = 0;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`event: board\ndata: ${JSON.stringify({ event })}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const abort = new AbortController();
  const start = watchStart(file);
  const options = { ...watchOptions(values, { config: { lanes: { core: {} } }, agents: start.agents }), since: 0 };
  const port = server.address().port;
  const done = followBoard({
    file, mainRoot: box.repo, commonDir: box.repo, config: { lanes: { core: {} } }, isMain: true,
    runCommand: () => assert.fail('a view is running, so no private API is needed'), serveApi: () => assert.fail('no private API'),
    refusalDocument: () => ({}), boardOpeners: {}, viewPorts: {}, options, start, signal: abort.signal,
    runningView: async () => ({ url: `http://127.0.0.1:${port}/?k=secret`, port }),
    quietReads, detailOf: (...args) => { lookups += 1; return realDetail(...args); },
    write: (text) => { lines.push(text); },
    note: (text) => { if (text.includes(`stream dropped after sequence ${last}`)) drained.resolve(); },
  });
  await drained.promise;
  abort.abort();
  assert.equal(await done, 0);
  return { lookups, lines };
}

/** The real lookup: a merged event has no shout or item, so its detail is its own fields. */
function realDetail(file, event) {
  const fields = Object.entries(JSON.parse(event.event_detail ?? '{}')).map(([name, value]) => `${name} ${value}`).join(', ');
  return { to: null, text: fields };
}

test('cli.journeys-watch-quiet-detail.with-watch-quietreads-on-and-kinds: clause 1: with watch.quietReads on and --kinds shout, 50 non-shout events make zero detail lookups and print nothing [C7,#9844]', async (t) => {
  const { lookups, lines } = await follow(t, true, { kinds: 'shout' });
  assert.equal(lookups, 0);
  assert.deepEqual(lines, []);
});

test('cli.journeys-watch-quiet-detail.with-no-filter-the-printed-lines: clause 2: with no filter the printed lines are identical with watch.quietReads on and off [C7,#9844]', async (t) => {
  const on = await follow(t, true, {});
  const off = await follow(t, false, {});
  assert.ok(on.lines.length >= COUNT, 'every event prints');
  assert.deepEqual(on.lines, off.lines);
  assert.equal(on.lookups, off.lookups);
});

test('cli.journeys-watch-quiet-detail.with-watch-quietreads-off-every-event: clause 3: with watch.quietReads off every event is looked up as today, even under --kinds shout [C7,#9844]', async (t) => {
  const { lookups, lines } = await follow(t, false, { kinds: 'shout' });
  assert.ok(lookups >= COUNT, 'each of the 50 events is looked up');
  assert.deepEqual(lines, []);
});
