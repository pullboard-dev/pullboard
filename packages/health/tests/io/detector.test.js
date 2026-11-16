/** The sentinel shouts when red gates come back unaccounted, and stays quiet when every red names its failures [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { JOB_SCHEMA_SQL } from '../../../store/index.js';
import { healthFindingNotice } from '../../../store/index.js';
import { normalizedHealthFindings } from '../../../store/index.js';
import { firstUnparsedLine } from '../../index.js';
import { unaccountedRedFindings } from '../../index.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 8, 18, 0, 0);
const UNNAMED = 'the submission proof is red at 0123456789ab; fix it, commit, submit again. 2 failed\nrun-tests: phases 1.2s\nknown-main acceptance unavailable: the proof has no complete named failure diagnostics';
const NAMED = 'test/a.test.js (case one)\nthe submission proof is red at 0123456789ab; fix it, commit, submit again. 1 failed';

/** A real SQLite file holding the job tables the board keeps, with a helper that records one finished gate. */
function board() {
  const files = privateFixtureFiles('unaccounted-red-');
  const db = new DatabaseSync(join(files.root, 'board.sqlite'));
  after(() => db.close());
  db.exec(JOB_SCHEMA_SQL);
  let count = 0;
  /** Record one gate job that ended `minutesAgo` minutes before NOW in `state`, with `message` as its refusal. */
  const gate = (item, minutesAgo, state, message) => {
    const id = `job-${item}-${count += 1}`;
    const at = NOW - minutesAgo * MINUTE;
    const record = { id, state, completedAt: new Date(at).toISOString(), ...(state === 'red' ? { error: { code: 'GATE_RED', message, next: 'fix it' } } : {}) };
    db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_created, job_updated) VALUES (?, ?, ?, ?, ?)').run(id, 'gate', item, at, at);
    db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)').run(id, state, JSON.stringify({ record }), at);
  };
  return { db, gate };
}

test('three red gates with unaccounted failures within an hour raise one Stuck shout naming the gates and the first unparsed line [C7]', () => {
  const { db, gate } = board();
  gate(101, 50, 'red', UNNAMED);
  gate(102, 30, 'red', UNNAMED);
  gate(103, 5, 'red', UNNAMED);
  gate(104, 3, 'green');
  gate(105, 2, 'red', NAMED);
  gate(106, 90, 'red', UNNAMED);
  const found = unaccountedRedFindings(db, new Date(NOW));
  assert.equal(found.length, 1, 'one finding, however many reds');
  const [finding] = normalizedHealthFindings(found);
  assert.equal(finding.owner, 'coordinator');
  const notice = healthFindingNotice(finding);
  assert.match(notice, /^Stuck: /u);
  for (const item of ['#101', '#102', '#103']) assert.ok(notice.includes(item), `${item} is named`);
  assert.ok(!notice.includes('#106'), 'a red older than an hour is outside the window');
  assert.ok(notice.includes('run-tests: phases 1.2s'), 'the first unparsed line is quoted');
  assert.equal(firstUnparsedLine(UNNAMED), 'run-tests: phases 1.2s');
  assert.deepEqual(unaccountedRedFindings(db, new Date(NOW)), found, 'the same scan reads the same finding, so the sentinel shouts it once');
});

test('red gates whose failures are fully accounted raise no shout [C7]', () => {
  const { db, gate } = board();
  for (const item of [201, 202, 203, 204]) gate(item, item - 195, 'red', NAMED);
  assert.deepEqual(unaccountedRedFindings(db, new Date(NOW)), []);
  assert.deepEqual(unaccountedRedFindings(new DatabaseSync(':memory:'), new Date(NOW)), [], 'a board without job tables has no reds to count');
});

test('one unaccounted red among a handful of accounted reds stays quiet below 20 percent [C7]', () => {
  const { db, gate } = board();
  gate(301, 10, 'red', UNNAMED);
  for (const item of [302, 303, 304, 305, 306]) gate(item, 5, 'red', NAMED);
  assert.deepEqual(unaccountedRedFindings(db, new Date(NOW)), []);
  gate(307, 4, 'red', UNNAMED);
  assert.equal(unaccountedRedFindings(db, new Date(NOW)).length, 1, 'two of seven reds is over 20 percent');
});
