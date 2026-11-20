/** @pullboard-test-input apps/cli/src/io/commands/flow.js apps/cli/tests/fixtures/e2e.js packages/stats/index.js packages/queue/index.js */
/** pullboard flow tune prints the cycle clock and the chooser result from the board windows, read-only [C7,#1099]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { chooseTuning } from '../../../../../../packages/stats/index.js';
import { tuneFixes } from '../../../../../../packages/stats/index.js';
import { tuneRecord } from '../../../../../../packages/stats/index.js';
import { LINE_SETTING_DEFINITIONS } from '../../../../../../packages/queue/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.flow-tune.json-prints-cycle-and-choice: clause 1: pullboard flow tune --json on a seeded board prints the cycle state and the chooser result, and changes no setting [C7,#1099]', async () => {
  const box = e2e.project();
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Seed the board', criterion: 'the page exists', check: 'test -f web/page.js', run: box.runLocal });
  const before = await box.runLocal(box.repo, 'settings', '--json');
  assert.equal(before.code, 0, before.err || before.out);
  const tuned = await box.runLocal(box.repo, 'flow', 'tune', '--json');
  assert.equal(tuned.code, 0, tuned.err || tuned.out);
  const result = JSON.parse(tuned.out);
  assert.equal(result.version, 1);
  assert.equal(result.cycle.due, false, 'a seeded board with no landings is not due');
  assert.equal(typeof result.cycle.reason, 'string');
  assert.equal(result.choice.kind, 'none', 'no repeated constraint, so the chooser names no change');
  const after = await box.runLocal(box.repo, 'settings', '--json');
  assert.equal(after.out, before.out, 'flow tune applies nothing');
  const text = await box.runLocal(box.repo, 'flow', 'tune');
  assert.equal(text.code, 0, text.err || text.out);
  assert.match(text.out, /flow tune: not due/u);
  assert.match(text.out, /choice: none; no setting changed/u);
});

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

/** A board whose two adjacent 4 h windows both have reviewWait as the constraint, with a wait over three times its target in the later one. */
async function reviewWaitBoard() {
  const box = e2e.project();
  landed(box, 901, { build: 10, wait: 60, review: 10, merge: 10, mergedAgo: 370 });
  landed(box, 902, { build: 10, wait: 100, review: 10, merge: 10, mergedAgo: 80 });
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const set = await box.runLocal(box.repo, 'settings', 'line', 'wipPerReviewer', '2', '--reason', 'Start the tuner from a known value', '--window', '{"windowMinutes":60}');
  assert.equal(set.code, 0, set.err || set.out);
  return box;
}

test('cli.flow-tune.apply-one-change: clause 1: pullboard flow tune --apply, run as the coordinator with line.tune on and a due cycle, records exactly one line_setting event with the key and value chooseTuning returns and the reason and window tuneRecord builds [C7,#1099]', async () => {
  const box = await reviewWaitBoard();
  const choice = chooseTuning([{ constraint: { stage: 'reviewWait' } }, { constraint: { stage: 'reviewWait' } }], tuneFixes({ wipPerReviewer: 2 }, LINE_SETTING_DEFINITIONS));
  assert.deepEqual(choice, { kind: 'setting', stage: 'reviewWait', key: 'wipPerReviewer', from: 2, to: 2.25 });
  const before = lineEvents(box).length;
  const applied = await box.runLocal(box.repo, 'flow', 'tune', '--apply', '--json');
  assert.equal(applied.code, 0, applied.err || applied.out);
  assert.equal(JSON.parse(applied.out).applied, true);
  const events = lineEvents(box);
  assert.equal(events.length, before + 1, 'exactly one line_setting event');
  const record = tuneRecord(choice, { windowMinutes: 240, overTargetMinutes: 70, landed: 1 });
  const { model, ...written } = events.at(-1);
  assert.equal(typeof model, 'string', 'the event names the writing model');
  assert.deepEqual(written, { key: choice.key, value: choice.to, reason: record.reason, window: Object.fromEntries(Object.entries(record.window).sort(([a], [b]) => a.localeCompare(b))) });
  const settings = JSON.parse((await box.runLocal(box.repo, 'settings', 'line', '--json')).out);
  assert.equal(settings.lineSettings.wipPerReviewer, 2.25, 'the board value moved to the chosen value, inside its range');
});

test('cli.flow-tune.revert-request-and-off: clause 2: the next due cycle records the reverse change when the constraint got worse, a choice of kind request is printed and writes nothing, and line.tune off or a cycle not due writes no event [C7,#1099]', async () => {
  const box = await reviewWaitBoard();
  assert.equal((await box.runLocal(box.repo, 'flow', 'tune', '--apply')).code, 0);
  assert.equal(lineEvents(box).at(-1).value, 2.25);
  // The same constraint got worse per landed item after the change: the next due cycle reverts it.
  landed(box, 903, { build: 10, wait: 200, review: 10, merge: 10, mergedAgo: 30 });
  const count = lineEvents(box).length;
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { line: { tune: false } });
  const off = await box.runLocal(box.repo, 'flow', 'tune', '--apply');
  assert.equal(off.code, 0, off.err || off.out);
  assert.match(off.out, /line\.tune is off/u);
  assert.equal(lineEvents(box).length, count, 'line.tune off writes no event');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const reverted = await box.runLocal(box.repo, 'flow', 'tune', '--apply');
  assert.equal(reverted.code, 0, reverted.err || reverted.out);
  const events = lineEvents(box);
  assert.equal(events.length, count + 1);
  assert.deepEqual([events.at(-1).key, events.at(-1).value], ['wipPerReviewer', 2], 'the reverse change');
  assert.match(events.at(-1).reason, /wipPerReviewer 2\.25 to 2$/u);
  // A build constraint in both windows is a request to the person for a seat, never a setting.
  const request = e2e.project();
  // Eight landings over the two windows make the cycle due without a breach.
  for (let n = 0; n < 4; n += 1) {
    landed(request, 911 + n, { build: 400, wait: 5, review: 5, merge: 5, mergedAgo: 370 - n });
    landed(request, 921 + n, { build: 400, wait: 5, review: 5, merge: 5, mergedAgo: 80 - n });
  }
  fixtureSettledMachine(request.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const asked = await request.runLocal(request.repo, 'flow', 'tune', '--apply');
  assert.equal(asked.code, 0, asked.err || asked.out);
  assert.match(asked.out, /the person decides a seat/u);
  assert.equal(lineEvents(request).length, 0, 'a request writes no setting');
  // No landing in either window: the cycle is not due, so nothing is written.
  const idle = e2e.project();
  fixtureSettledMachine(idle.env.PULLBOARD_MACHINE_HOME, { line: { tune: true } });
  const quiet = await idle.runLocal(idle.repo, 'flow', 'tune', '--apply');
  assert.equal(quiet.code, 0, quiet.err || quiet.out);
  assert.match(quiet.out, /not due/u);
  assert.equal(lineEvents(idle).length, 0);
});
