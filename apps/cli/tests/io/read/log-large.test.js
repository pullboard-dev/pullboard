/** @pullboard-test-input apps/cli/src/io/commands/log.js packages/store/src/io/board/query.js */
/** pullboard log streams a board of 200,000 events instead of building one string, with --all and as filtered NDJSON [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { openKitBoard } from '../../fixtures/board.js';
import { closeBoard } from '../../../../../packages/store/index.js';

const EVENTS = 200_000;
const MERGED_EVERY = 10;

/** A project whose board holds the given number of events: every tenth one a merge, one per second from a fixed start. */
function bigBoard(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    board.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EVENTS})
      INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail)
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 1800000000 + i, 'unixepoch'), 'coordinator', CASE WHEN i % ${MERGED_EVERY} = 0 THEN 'merged' ELSE 'shout' END, NULL, '{}' FROM n`);
  } finally { closeBoard(board); }
  return { box, run: (...args) => box.runIn(box.repo, ...args) };
}

test('clause 1: pullboard log --json --since --kind streams NDJSON on a board with 200,000 events without error [C7]', async (t) => {
  const { run } = bigBoard(t);
  const since = new Date((1800000000 + EVENTS / 2) * 1000).toISOString();
  const answer = await run('log', '--json', '--since', since, '--kind', 'merged');
  assert.equal(answer.status, 0, answer.stderr);
  const rows = answer.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, EVENTS / 2 / MERGED_EVERY + 1, 'every merge event from the cut-off on, and only those');
  assert.ok(rows.every(row => row.event_kind === 'merged' && row.event_at >= since));
});

test('clause 2: pullboard log --all prints every event on a board with 200,000 events, not stopping early [C7]', async (t) => {
  const { run } = bigBoard(t);
  const answer = await run('log', '--all');
  assert.equal(answer.status, 0, answer.stderr);
  const lines = answer.stdout.split('\n').filter(line => /^20\d\d-\d\d-\d\dT/u.test(line));
  // The project's own set-up events come first; every seeded one is there, through the last.
  assert.ok(lines.length >= EVENTS, `one line per event, ${lines.length} printed`);
  assert.match(lines.at(-1), /^2027-01-17T15:33:20/u, 'the newest event is the last line');
  assert.doesNotMatch(answer.stdout, /lines withheld/u);
});
