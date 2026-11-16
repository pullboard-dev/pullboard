/** A big board is exported in bounded batches, never read whole [N26,C7]. */
import assert from 'node:assert/strict';
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportView } from '../../index.js';

const BOARD = '/api/v1/boards/b1';
const EVENTS = Array.from({ length: 7 }, (_, index) => ({ event_id: index + 1, event_type: 'add', event_detail: '{}' }));
const SUMMARIES = [1, 2, 3].map(id => ({ id, title: `Item ${id}`, state: 'open' }));
const DETAILS = new Map(SUMMARIES.map(item => [item.id, { ...item, criterion: `Item ${item.id} is in the snapshot`, thread: [{ at: 't', text: `note ${item.id}` }], history: [] }]));

/**
 * A stand-in board reader that serves summaries, item details and events in pages by the limit and after cursors,
 * and records every path it was asked for.
 *
 * @pullboard-test-input apps/view/src/io/serve.js
 */
function standInBoard() {
  const asked = [];
  const source = async path => {
    asked.push(path);
    const url = new URL(path, 'http://stand-in.invalid');
    if (url.pathname === '/api/v1/boards') return { version: 1, boards: [{ id: 'b1' }] };
    if (url.pathname === BOARD + '/state') return { version: 1, state: { events: [EVENTS.at(-1)], items: SUMMARIES } };
    const item = url.pathname.match(/\/items\/(\d+)$/u);
    if (item) return { version: 1, item: DETAILS.get(Number(item[1])) };
    if (url.pathname === BOARD + '/events') {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      return { version: 1, events: EVENTS.filter(event => event.event_id > after).slice(0, limit) };
    }
    throw new Error(`the stand-in board does not serve ${path}`);
  };
  return { asked, source };
}

test('clause 2: an export reads events in bounded batches and still writes the whole board [N26,C7]', async t => {
  const dir = cellSandbox(t).dir;
  const { asked, source } = standInBoard();
  const output = join(dir, 'snapshot');
  await exportView(dir, output, { source, eventBatch: 2, renderPage: () => '<html></html>' });

  const eventReads = asked.filter(path => path.includes('/events?')).map(path => new URL(path, 'http://stand-in.invalid').searchParams);
  assert.ok(eventReads.length > 2, `a log longer than one batch is read in several pages: ${eventReads.length}`);
  assert.deepEqual(eventReads.map(query => query.get('limit')), eventReads.map(() => '2'), 'every events read is bounded by the batch size');
  assert.deepEqual(eventReads.map(query => Number(query.get('after'))), eventReads.map((_, index) => 2 * index), 'each page starts after the last event of the one before');
  assert.deepEqual(asked.filter(path => path.includes('/state')), [BOARD + '/state?detail=summary'], 'the state is read once, as summaries');

  const written = JSON.parse(readFileSync(join(output, 'api', 'v1', 'boards', 'b1', 'events.json'), 'utf8'));
  assert.deepEqual(written.events, EVENTS, 'the paged log is the whole log, in order, each event once');
  const state = JSON.parse(readFileSync(join(output, 'api', 'v1', 'boards', 'b1', 'state.json'), 'utf8'));
  assert.deepEqual(state.state.items, SUMMARIES.map(summary => ({ ...summary, ...DETAILS.get(summary.id) })), 'each exported item is its summary with its own detail');
});
