/** Routine maintenance compacts the board once a day and reports its bytes before and after [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { JOB_SCHEMA_SQL } from '../../../../packages/store/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const DAY = 86_400_000;

/** A project whose one item is landed 40 days ago and has a gate job with twelve 8 KB steps; returns the board file and counts. */
function oldLanded() {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Old landed work', criterion: 'It was done.', check: 'true', args: ['--specs', 'G1'] }).item_id;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file);
  try {
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    db.exec(JOB_SCHEMA_SQL);
    // The fixture ages an item no move reached: drop the machine guards, write, and restore their exact SQL.
    const guards = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
    db.exec(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all().map(row => `DROP TRIGGER "${row.name}";`).join(' '));
    db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(old, 'coordinator', 'merged', item, '{}');
    db.prepare("UPDATE item SET item_status = 'verified', item_updated_at = ? WHERE item_id = ?").run(old, item);
    for (const { sql } of guards) db.exec(sql);
    db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_created, job_updated) VALUES (?, ?, ?, ?, ?)').run('gate:old', 'gate', item, Date.now() - 40 * DAY, Date.now() - 40 * DAY);
    const step = db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)');
    for (let n = 0; n < 12; n += 1) step.run('gate:old', n === 11 ? 'done' : 'phase', n, JSON.stringify({ n, text: 'x'.repeat(8000) }), Date.now() - 40 * DAY + n);
    db.prepare("UPDATE job SET job_step = 'done' WHERE job_id = 'gate:old'").run();
  } finally { db.close(); }
  return { box, file, item };
}


/** Commit the private fixture's opt-in to routine maintenance. */
function enable(box) {
  const file = join(box.repo, 'pullboard.json'), config = JSON.parse(readFileSync(file, 'utf8'));
  config.worktreeMaintenance = { enabled: true, every: '1h', grace: '1d', exclude: [] };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: enable private fixture maintenance');
}

test('clause 1: routine maintenance compacts the board and reports bytes before and after, then waits a day [C7]', async () => {
  const { box } = oldLanded();
  enable(box);
  const first = await box.inProcess(box.repo, 'maintenance', '--json');
  assert.equal(first.code, 0, first.err);
  const compaction = JSON.parse(first.out).compaction;
  assert.equal(compaction.ran, true, 'the first run compacts');
  assert.ok(compaction.rows >= 11, `the old job's steps were archived: ${JSON.stringify(compaction)}`);
  assert.ok(compaction.before > compaction.after, `the board file shrank: ${compaction.before} B to ${compaction.after} B`);
  const text = await box.inProcess(box.repo, 'maintenance');
  assert.match(text.out, /^board compaction: next at \d{4}-\d\d-\d\dT/mu, 'a second run inside the day does not compact again');
  const again = JSON.parse((await box.inProcess(box.repo, 'maintenance', '--json')).out).compaction;
  assert.equal(again.ran, false);
  assert.equal(again.before, compaction.before, 'the day\'s report still names the bytes of the run that compacted');
});

test('clause 1: maintenance left off compacts nothing and says nothing about it [C7]', async () => {
  const { box } = oldLanded();
  const run = await box.inProcess(box.repo, 'maintenance');
  assert.equal(run.code, 0, run.err);
  assert.doesNotMatch(run.out, /compaction/u);
});
