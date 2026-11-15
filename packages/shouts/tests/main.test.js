/** The shouts cell refuses glued prose, reads watch flags into filters and follows a board's live events without missing or repeating one [B7,A2,N26,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { cellBoard } from '../../store/tests/fixtures/cell.js';
import { cellItem } from '../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../store/tests/fixtures/cell.js';
import { shout } from '../../store/index.js';
import { followBoard } from '../index.js';
import { requireReadableShout } from '../index.js';
import { watchOptions } from '../index.js';
import { watchStart } from '../index.js';

const CONFIG = { lanes: { core: {}, view: {} } };
const AGENTS = [{ agent_id: 'core-1', agent_lane: 'core' }, { agent_id: 'view-2', agent_lane: 'view' }];
const options = values => watchOptions(values, { config: CONFIG, agents: AGENTS });

test('a shout with glued prose is refused, and hashes, URLs and quoted examples are not prose [B7,N26]', () => {
  const glued = 'thisisaverylongglueddescriptionofwork with spaces';
  assert.throws(() => requireReadableShout(glued), error => error.code === 'SHOUT_SPACES');
  assert.throws(() => requireReadableShout('THISISAVERYLONGSHOUTEDDESCRIPTIONHERE'), error => error.code === 'SHOUT_SPACES');
  assert.doesNotThrow(() => requireReadableShout('merged at 0123456789abcdef0123456789abcdef01234567 and ' + 'a'.repeat(64)));
  assert.doesNotThrow(() => requireReadableShout('see https://example.com/averyveryveryverylongpathsegmentwithoutspaces for this'));
  assert.doesNotThrow(() => requireReadableShout('the old text was `thisisaverylongglueddescriptionofwork` and now it reads fine'));
  assert.throws(() => requireReadableShout('"thisisaverylongglueddescriptionofwork"'), error => error.code === 'SHOUT_SPACES', 'a quoted example alone is the whole message');
});

test('watch flags become filters, and every bad value is refused with a usage error before anything is followed [A2,N26]', () => {
  const plain = options({});
  assert.deepEqual({ ...plain, to: null }, { kinds: null, item: null, to: null, work: null, reviewWaitMs: 20 * 60_000, since: null, json: false });
  const filtered = options({ kinds: 'shout, submit,', item: '12', to: 'core-1', work: 'core', 'review-wait': '5', since: '120', json: true });
  assert.deepEqual([...filtered.kinds], ['shout', 'submit']);
  assert.equal(filtered.item, 12);
  assert.deepEqual([...filtered.to].sort(), ['all', 'core', 'core-1']);
  assert.equal(filtered.reviewWaitMs, 5 * 60_000);
  assert.equal(filtered.since, 120);
  assert.equal(filtered.json, true);
  assert.deepEqual([...options({ to: 'view' }).to].sort(), ['all', 'view']);
  for (const to of ['all', 'person', 'coordinator']) assert.ok(options({ to }).to.has(to));
  for (const bad of [{ kinds: ',' }, { item: '0' }, { item: 'x' }, { to: 'nobody' }, { work: 'nowhere' }, { 'review-wait': '5' },
    { work: 'core', 'review-wait': '' }, { work: 'core', 'review-wait': '-1' }, { since: '-3' }, { since: '1.5' }]) {
    assert.throws(() => options(bad), error => error.code === 'USAGE', JSON.stringify(bad));
  }
});

/** A real board holding two seats, an item and two shouts, with the repository it lives in. */
function shoutedBoard(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const core = cellSeat(board, { lane: 'web', path: repo.root + '/a' });
  const other = cellSeat(board, { lane: 'api', path: repo.root + '/b' });
  const item = cellItem(board, { lane: 'web', title: 'Render the page', criterion: '1. it renders [test]' });
  const lanes = ['web', 'api'];
  shout(board, { from: core.id, to: other.id, text: 'hello there', lanes });
  shout(board, { from: other.id, to: 'web', text: 'for the web lane', lanes });
  return { repo, board, core, other, item };
}

test('watchStart reads the board id, its seats and its latest event sequence from the file alone [A2,N26]', t => {
  const { repo, core, other, board } = shoutedBoard(t);
  const start = watchStart(repo.boardFile);
  assert.match(start.id, /\S/u);
  assert.deepEqual(start.agents.map(agent => agent.agent_id).sort(), [core.id, other.id].sort());
  assert.equal(start.sequence, board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id);
  assert.ok(start.sequence > 0);
});

/**
 * Serve the board's recorded events over a live-stream endpoint: the first request gets every event after its
 * last-event-id and ends; later requests are kept open and reported.
 */
async function eventServer(t, events) {
  const requests = [];
  const waiting = [];
  const server = createServer((request, response) => {
    const after = Number(request.headers['last-event-id']);
    requests.push({ url: request.url, key: request.headers['x-pullboard-key'], after });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      for (const event of events.filter(entry => entry.event_id > after)) response.write(`event: board\ndata: ${JSON.stringify({ event })}\n\n`);
      response.write('event: board\ndata: {"event":{"event_kind":"changed"}}\n\n');
      response.end();
    } else { waiting.push(response); for (const done of server.reconnected ?? []) done(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const response of waiting) response.destroy(); server.closeAllConnections(); server.close(); });
  server.reconnected = [];
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/?k=secret`, port: server.address().port };
}

/**
 * Follow a board against a recorded-event server until the stream has dropped once and been followed again.
 *
 * @returns {Promise<{ lines: string[], notes: string[], requests: object[] }>}
 */
async function follow(t, shouted, watchFlags) {
  const events = shouted.board.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  const served = await eventServer(t, events);
  const abort = new AbortController();
  const lines = [];
  const notes = [];
  served.server.reconnected.push(() => abort.abort());
  const start = watchStart(shouted.repo.boardFile);
  const code = await followBoard({
    file: shouted.repo.boardFile, mainRoot: shouted.repo.root, commonDir: shouted.repo.root, config: CONFIG, isMain: true,
    runCommand: () => assert.fail('a view is running, so no private API is needed'), serveApi: () => assert.fail('no private API'),
    refusalDocument: () => ({}), boardOpeners: {}, viewPorts: {},
    options: { ...watchOptions(watchFlags, { config: { lanes: { web: {}, api: {} } }, agents: start.agents }), since: 0 },
    start, signal: abort.signal,
    runningView: async () => ({ url: served.url, port: served.port }),
    write: text => lines.push(text), note: text => notes.push(text),
  });
  assert.equal(code, 0);
  return { lines, notes, requests: served.requests };
}

test('following prints one line per event in order, skips change pings, and follows a dropped stream from the last sequence [A2,N26]', async t => {
  const shouted = shoutedBoard(t);
  const { lines, notes, requests } = await follow(t, shouted, {});
  const events = shouted.board.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  assert.equal(lines.length, events.length);
  assert.ok(lines.every(line => line.endsWith('\n') && line.split('\n').length === 2), 'one line each');
  assert.deepEqual(lines.map(line => Number(line.split(' ')[0])), events.map(event => event.event_id), 'in event order');
  const printed = lines.join('');
  assert.match(printed, /\d+ shout\w* - \S+ to \S+: hello there\n/u);
  assert.match(printed, /\d+ add #\d+ coordinator Render the page/u, 'an item event prints its id and title');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, 'secret');
  assert.equal(requests[0].after, 0);
  assert.equal(requests[1].after, events.at(-1).event_id, 'the second follow starts after the last event printed, so nothing repeats');
  assert.match(notes[0], /following the view on port \d+ after sequence 0/u);
  assert.match(notes[1], /the stream dropped after sequence \d+; following again/u);
  assert.match(requests[0].url, /\/api\/v1\/boards\/[^/]+\/events\?signals=none$/u, 'events only: no changed notices without --work');
});

test('filters keep only the wanted kinds, item and audience, and --json prints one versioned document per line [A2,N26]', async t => {
  const shouted = shoutedBoard(t);
  const recorded = shouted.board.db.prepare('SELECT event_kind FROM event ORDER BY event_id').all().map(row => row.event_kind);
  const shoutKinds = [...new Set(recorded.filter(kind => kind.startsWith('shout')))];
  const byKind = await follow(t, shouted, { kinds: shoutKinds.join(',') });
  assert.equal(byKind.lines.length, recorded.filter(kind => shoutKinds.includes(kind)).length);
  assert.ok(byKind.lines.length >= 2 && byKind.lines.every(line => /^\d+ shout/u.test(line)));

  const toWeb = await follow(t, shouted, { to: 'web', json: true });
  const records = toWeb.lines.map(line => JSON.parse(line));
  assert.equal(records.length, 1, 'only the shout to the web lane reaches the web audience; the one to another seat does not');
  assert.equal(records[0].version, 1);
  assert.match(records[0].kind, /^shout/u);
  assert.equal(records[0].to, 'web');

  const byItem = await follow(t, shouted, { item: String(shouted.item.item_id) });
  assert.ok(byItem.lines.length >= 1);
  assert.ok(byItem.lines.every(line => line.split(' ')[2] === `#${shouted.item.item_id}`));
});
