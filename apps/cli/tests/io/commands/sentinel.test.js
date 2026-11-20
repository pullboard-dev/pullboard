/** @pullboard-test-input apps/cli/src/io/commands/sentinel.js apps/cli/src/io/commands/flow.js apps/cli/tests/fixtures/e2e.js packages/stats/index.js packages/queue/index.js */
/** One pullboard sentinel pass runs the line tune apply, so the line tunes on the board cadence [C7,#1099]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const MINUTE = 60_000;

/** Write one landed item's recorded cycle into the board, `mergedAgo` minutes before now, with the four stage lengths in minutes. */
function landed(box, id, { build, wait, review, merge, mergedAgo }) {
  const merged = Date.now() - mergedAgo * MINUTE;
  const accepted = merged - merge * MINUTE;
  const reserved = accepted - review * MINUTE;
  const submitted = reserved - wait * MINUTE;
  const claimed = submitted - build * MINUTE;
  const iso = (ms) => new Date(ms).toISOString();
  const commit = String(id % 10).repeat(40);
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const insert = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (const [at, by, kind, detail] of [
    [claimed - MINUTE, 'coordinator', 'add', { lane: 'web' }],
    [claimed, `web-${id}`, 'claim', { leaseUntil: iso(merged + 600 * MINUTE) }],
    [submitted, `web-${id}`, 'submit', { commit }],
    [reserved, 'web-review', 'reserve', { until: iso(merged + 600 * MINUTE) }],
    [accepted, 'web-review', 'accept', { commit }],
    [merged, 'coordinator', 'merged', { commit: 'a'.repeat(40) }],
  ]) insert.run(iso(at), by, kind, id, JSON.stringify(detail));
  db.close();
}

/** The recorded line setting events, oldest first, with their decoded detail. */
function lineEvents(box) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  const rows = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'line_setting' ORDER BY event_id").all().map(row => JSON.parse(row.event_detail));
  db.close();
  return rows;
}

/** A board whose two adjacent 4 h windows both have reviewWait as the constraint, with a wait over three times its target in the later one, and line.tune on. */
async function dueBoard() {
  const box = e2e.project();
  landed(box, 901, { build: 10, wait: 60, review: 10, merge: 10, mergedAgo: 370 });
  landed(box, 902, { build: 10, wait: 100, review: 10, merge: 10, mergedAgo: 80 });
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const set = await box.runLocal(box.repo, 'settings', 'line', 'wipPerReviewer', '2', '--reason', 'Start the tuner from a known value', '--window', '{"windowMinutes":60}');
  assert.equal(set.code, 0, set.err || set.out);
  return box;
}

test('cli.sentinel.runs-line-tune: clause 1: one sentinel pass run in process with line.tune on and a due cycle makes the one line change flow tune --apply would make, and a pass with the cycle not due makes none [C7,#1099]', async () => {
  const box = await dueBoard();
  const before = lineEvents(box).length;
  const pass = await box.runLocal(box.repo, 'sentinel', 'run');
  assert.equal(pass.code, 0, pass.err || pass.out);
  const events = lineEvents(box);
  assert.equal(events.length, before + 1, 'one pass makes exactly one line change');
  assert.deepEqual([events.at(-1).key, events.at(-1).value], ['wipPerReviewer', 2.25], 'the change tune --apply chooses for this board');
  assert.match(pass.out, /flow tune --apply: wipPerReviewer 2 to 2\.25/u, 'the pass output names the change');
  // No landing in either window: the cycle is not due, so a pass writes nothing.
  const idle = e2e.project();
  fixtureSettledMachine(idle.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const quiet = await idle.runLocal(idle.repo, 'sentinel', 'run');
  assert.equal(quiet.code, 0, quiet.err || quiet.out);
  assert.equal(lineEvents(idle).length, 0, 'a cycle not due makes no change');
});

test('cli.sentinel.line-tune-off-and-refusal: clause 2: a sentinel pass with line.tune off never runs the tuner, and a tuner refusal is reported in the pass output without failing the pass [C7,#1099]', async () => {
  const off = await dueBoard();
  fixtureSettledMachine(off.env.PULLBOARD_MACHINE_HOME, { line: { tune: false } });
  const count = lineEvents(off).length;
  const quiet = await off.runLocal(off.repo, 'sentinel', 'run');
  assert.equal(quiet.code, 0, quiet.err || quiet.out);
  assert.equal(lineEvents(off).length, count, 'line.tune off writes no event');
  assert.doesNotMatch(quiet.out, /flow tune/u, 'the tuner never ran');
  // A seat that is not the coordinator cannot record a line setting: the pass reports the refusal and still succeeds.
  const refused = await dueBoard();
  const before = lineEvents(refused).length;
  const pass = await refused.runLocal(refused.web, 'sentinel', 'run');
  assert.equal(pass.code, 0, pass.err || pass.out);
  assert.match(pass.out, /flow tune --apply: refused \(COORDINATOR_ONLY\)/u);
  assert.equal(lineEvents(refused).length, before, 'a refused apply writes nothing');
});
