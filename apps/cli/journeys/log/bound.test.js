/** @pullboard-test-input apps/cli/src/io/commands/log.js packages/store/src/io/board/query.js */
/** @pullboard-world-pin: reads the log command source to learn the bound it applies, so the test follows the command instead of repeating the number [C7]. */
/** pullboard log keeps to the newest 50 events unless asked for all of them, and filtered reads are unchanged [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openKitBoard } from '../../tests/fixtures/board.js';
import { closeBoard } from '../../../../packages/store/index.js';

const SEEDED = 450;
const START = 1800000000;
/** The bound the command applies, read from its source so the test follows it. */
const PLAIN_LOG_EVENTS = Number(/PLAIN_LOG_EVENTS = (\d+)/u.exec(readFileSync(new URL('../../src/io/commands/log.js', import.meta.url), 'utf8'))[1]);
/** The ISO second of the nth seeded event, as the log prints it. */
const stamp = n => new Date((START + n) * 1000).toISOString().slice(0, 19);
const EVENT_LINE = /^20\d\d-\d\d-\d\dT/u;

/** A project whose board holds more than 50 events: SEEDED extra ones, every fifth a merge, one per second. */
function bigBoard(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const path = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openKitBoard(path);
  try {
    board.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SEEDED})
      INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail)
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ${START} + i, 'unixepoch'), 'coordinator', CASE WHEN i % 5 = 0 THEN 'merged' ELSE 'shout' END, NULL, '{}' FROM n`);
  } finally { closeBoard(board); }
  return { run: (...args) => box.runIn(box.repo, ...args) };
}

test('cli.journeys-log-bound.plain-pullboard-log-prints-the-last: clause 1: plain pullboard log prints the last 50 events of a board holding more, within 8192 bytes [C7]', async (t) => {
  const { run } = bigBoard(t);
  const answer = await run('log');
  assert.equal(answer.status, 0, answer.stderr);
  const lines = answer.stdout.split('\n').filter(line => EVENT_LINE.test(line));
  assert.ok(SEEDED > PLAIN_LOG_EVENTS, 'the board holds more events than the bound');
  assert.equal(lines.length, PLAIN_LOG_EVENTS);
  assert.ok(lines.at(-1).startsWith(stamp(SEEDED)), 'the newest event is the last line');
  assert.ok(Buffer.byteLength(answer.stdout) < 8192, `the plain log is ${Buffer.byteLength(answer.stdout)} bytes, under the 8192-byte inbox budget`);
  assert.ok(lines[0].startsWith(stamp(SEEDED - PLAIN_LOG_EVENTS + 1)), 'the oldest kept event is the first line');
});

test('cli.journeys-log-bound.pullboard-log-all-prints-every-event: clause 2: pullboard log --all prints every event of that board [C7]', async (t) => {
  const { run } = bigBoard(t);
  const answer = await run('log', '--all');
  assert.equal(answer.status, 0, answer.stderr);
  const lines = answer.stdout.split('\n').filter(line => EVENT_LINE.test(line));
  assert.ok(lines.length >= SEEDED, `one line per event, ${lines.length} printed`);
  assert.ok(lines.at(-1).startsWith(stamp(SEEDED)));
});

test('cli.journeys-log-bound.pullboard-log-json-with-since-and: clause 3: pullboard log --json with --since and with --kind returns every matching event, unbounded [C7]', async (t) => {
  const { run } = bigBoard(t);
  const since = new Date((START + 100) * 1000).toISOString();
  const bySince = await run('log', '--json', '--since', since);
  assert.equal(bySince.status, 0, bySince.stderr);
  assert.equal(bySince.stdout.trimEnd().split('\n').length, SEEDED - 100 + 1, 'every event from the cut-off on');
  const byKind = await run('log', '--json', '--kind', 'merged');
  assert.equal(byKind.status, 0, byKind.stderr);
  const rows = byKind.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length >= SEEDED / 5, 'all merge events, not just the newest bounded set');
  assert.ok(rows.every(row => row.event_kind === 'merged'));
});
