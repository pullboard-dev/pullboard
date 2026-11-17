/** Export and Git sync stream a board whose events exceed one JavaScript string, and the events API honours its limit [C7]. */
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';
import { createApiHandler } from '../../../api/index.js';
import { exportBoard } from '../../../store/index.js';
import { semanticBoardDigest } from '../../../store/index.js';
import { writeJsonChunks } from '../../../store/index.js';
import { syncGitBoard } from '../../index.js';

const ROW = 8_000_000;
const ROWS = Math.ceil(constants.MAX_STRING_LENGTH / ROW) + 2;

/** Append enough event rows that the board's events alone cannot be serialised into one string. */
function fatten(board) {
  const insert = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-10T00:00:00.000Z', 'coordinator', 'shout', NULL, ?)");
  const detail = JSON.stringify({ text: 'x'.repeat(ROW) });
  for (let row = 0; row < ROWS; row += 1) insert.run(detail);
  return ROWS;
}

test('sync.large.export-streams-oversized-board: clause 1: export streams a board whose events exceed one string, and its digest is read the same way [C7]', t => {
  const board = fixtureBoard(t);
  const added = fatten(board);
  const document = exportBoard(board);
  assert.throws(() => JSON.stringify(document), RangeError, 'the whole document is more than one string');
  let bytes = 0, pieces = 0;
  writeJsonChunks(document, text => { bytes += text.length; pieces += 1; }, 2);
  assert.ok(bytes > constants.MAX_STRING_LENGTH, 'the export wrote more characters than one string holds');
  assert.ok(pieces > added / 2, 'and wrote them in many pieces');
  assert.match(semanticBoardDigest(document), /^[0-9a-f]{64}$/u);
});

test('sync.large.publish-oversized-board: clause 1: sync publishes a board whose events exceed one string [C7]', async t => {
  const { root: folder } = privateFixtureFiles('pullboard-large-sync-');
  const sh = (cwd, ...args) => runFixtureGit(args, { cwd, encoding: 'utf8' });
  sh(folder, 'init', '-q', '--bare', 'origin.git');
  const root = join(folder, 'work');
  sh(folder, 'init', '-q', 'work');
  sh(root, 'remote', 'add', 'origin', join(folder, 'origin.git'));
  sh(root, 'config', 'user.name', 'fixture');
  sh(root, 'config', 'user.email', 'fixture@example.invalid');
  sh(root, 'commit', '-q', '--allow-empty', '-m', 'chore: start');
  const board = fixtureBoard(t);
  fatten(board);
  const result = await syncGitBoard(root, board, { relayCommand: { cliOperation: 'sync' } });
  assert.equal(result.sequence, 0);
  const origin = join(folder, 'origin.git');
  const size = Number(sh(origin, 'cat-file', '-s', 'refs/pullboard/board:payload.json'));
  assert.ok(size > constants.MAX_STRING_LENGTH, 'the published baseline is larger than one string');
});

test('sync.large.events-api-limit: clause 1: the events API honours its limit query and refuses a bad one [C7]', async t => {
  const log = Array.from({ length: 25 }, (_, index) => ({ event_id: index + 1 }));
  const asked = [];
  const handler = createApiHandler({ refusalDocument: error => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
    authenticate: () => ({ local: true }), board: id => ({ id }),
    events: (_board, after, _who, limit) => { asked.push(limit); return log.filter(event => event.event_id > after).slice(0, limit ?? log.length); } });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const read = async query => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/events${query}`);
    return { status: response.status, document: await response.json() };
  };
  const page = await read('?after=3&limit=5');
  assert.deepEqual(page.document.events.map(event => event.event_id), [4, 5, 6, 7, 8]);
  assert.equal((await read('')).document.events.length, 25, 'without a limit every event follows the cursor');
  assert.deepEqual(asked, [5, undefined]);
  for (const bad of ['0', '-1', 'x', '1.5']) {
    const refused = await read(`?limit=${bad}`);
    assert.equal(refused.document.error?.code, 'BAD_REQUEST', `limit=${bad} is refused`);
  }
});
