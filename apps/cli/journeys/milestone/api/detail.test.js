import { openBoard } from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../tests/fixtures/child.js';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../../packages/store/index.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { timedMs } from '../../../tests/fixtures/api.js';
import { addRoutedItem } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';
import { WRITER } from '../../../tests/fixtures/api/milestone.js';

test('[N26,A2] an item detail answers under 20 ms on a large board', async (t) => {
  const box = project();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: seed 1000 items into the fixture board the real served API then reads.
  const board = openBoard(boardFile, undefined, { isMain: true });
  const ids = [];
  try {
    for (let index = 0; index < 1000; index += 1) ids.push(addRoutedItem(board, { by: 'coordinator', lane: 'app', title: `Large item ${index + 1}`,
      criterion: `Detail ${index + 1}`, specIds: ['G1'], route: 'light', brief: 'Files:\n- app/large.js\nChange:\n- Keep it.\nTest:\n- It reads fast.', check: 'true' }));
    const insert = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'edit', ?, '{}')");
    board.db.exec('BEGIN'); // One transaction seeds the remaining events up to 40,000.
    for (let event = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n; event < 40_000; event += 1) insert.run(new Date(Date.UTC(2026, 0, 1, 0, 0, event)).toISOString(), ids[event % 1000]);
    board.db.exec('COMMIT');
  } finally { closeBoard(board); }
  const builds = [];
  const api = await startLocalHandler(t, box, { personChannel: 'api', stateDetail: 'summary', onItemBuild: (entry) => builds.push(entry.itemId) });
  const path = `/api/v1/boards/${(await (await apiFetch(api, '/api/v1/boards')).json()).boards[0].id}`;
  const polled = await apiFetch(api, `${path}/state`);
  assert.equal((await polled.json()).state.items.length, 1000);
  const unchanged = await apiFetch(api, `${path}/state`, { headers: { 'if-none-match': polled.headers.get('etag') } });
  assert.equal(unchanged.status, 304, 'an unchanged state poll gets a not-modified reply');
  assert.equal(await unchanged.text(), '');
  const stop = join(box.dir, 'stop-writer');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', WRITER, boardFile, stop], { stdio: ['ignore', 'pipe', 'pipe'] });
  let written = ''; writer.stdout.on('data', (part) => { written += part; });
  while (!written.includes('ready')) await new Promise((done) => setTimeout(done, 5));
  const times = [];
  try {
    for (const id of ids.slice(0, 20)) times.push(await timedMs(async () => assert.equal((await (await apiFetch(api, `${path}/items/${id}`)).json()).item.id, id)));
  } finally { writeFileSync(stop, ''); await once(writer, 'close'); }
  assert.ok(Number(written.split('\n')[1]) > 0, 'an agent wrote to the board while the details were read');
  const sorted = [...times].sort((left, right) => left - right), median = (sorted[9] + sorted[10]) / 2;
  const report = `item detail ms, median ${median.toFixed(1)}: ${times.map((ms) => ms.toFixed(1)).join(' ')}`; t.diagnostic(report);
  assert.ok(median < 20 && sorted[19] < 50, report); // budget: declared by approved row N26 item #1040: median under 20 ms, none over 50 ms
  await (await apiFetch(api, `${path}/items/${ids[19]}`)).json();
  builds.length = 0;
  assert.equal((await (await apiFetch(api, `${path}/items/${ids[19]}`)).json()).item.id, ids[19]);
  assert.deepEqual(builds, [], 'an item whose last event has not moved is served from its cached detail');
});

