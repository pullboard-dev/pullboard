/** pullboard compact archives old finished items' job steps beside the board and leaves items and events alone [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

/** The row counts of the tables compaction must or must not touch. */
function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['item', 'event', 'job_step'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  } finally { db.close(); }
}

test('clause 1: compact --dry-run reports the steps it would archive and changes nothing [C7]', async () => {
  const { box, file } = oldLanded();
  const before = counts(file);
  const dry = await box.runLocal(box.repo, 'compact', '--dry-run', '--json');
  assert.equal(dry.code, 0, `${dry.out}\n${dry.err}`);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.rows, 11);
  assert.equal(report.dryRun, true);
  assert.deepEqual(counts(file), before);
});

test('clause 1: compact moves an old landed item\'s steps to a gzip beside the board, keeps its last step, and shrinks the file [C7]', async () => {
  const { box, file } = oldLanded();
  const before = counts(file);
  const result = await box.runLocal(box.repo, 'compact', '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rows, 11);
  assert.ok(report.after < report.before, `${report.after} < ${report.before}`);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard', 'job-steps.archive.ndjson.gz')));
  const after = counts(file);
  assert.equal(after.item, before.item);
  assert.equal(after.event, before.event, 'no event is archived');
  assert.equal(after.job_step, 1, 'the job keeps its last step');
});
