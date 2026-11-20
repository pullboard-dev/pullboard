/** @pullboard-test-input source-cell packages/moves */
/** Each live job the board offered is judged by the backbone's serves rule for its kind, read-only, and a missing input is unreadable, never a disagreement [C7,#10580]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { backboneSummary } from '../../../src/io/table/backbone-records.js';
import { readBackboneRecords } from '../../../src/io/table/backbone-records.js';

const COMMIT = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const SINCE = '2026-11-17T00:00:00.000Z';
const AT = Date.parse(SINCE) + 1000;
const files = privateFixtureFiles('pullboard-backbone-records-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** A board with the job, job_step and item columns the reader selects, at `file` or in memory. */
function board(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_status TEXT, item_owner TEXT, item_commit TEXT, item_frozen_digest TEXT, item_review_by TEXT, item_check TEXT NOT NULL DEFAULT '');
    CREATE TABLE job (job_id TEXT PRIMARY KEY, job_kind TEXT NOT NULL, job_item INTEGER, job_candidate TEXT, job_base TEXT, job_step TEXT NOT NULL, job_created INTEGER NOT NULL);
    CREATE TABLE job_step (job_step_id INTEGER PRIMARY KEY AUTOINCREMENT, job_step_job TEXT NOT NULL, job_step_name TEXT NOT NULL, job_step_seq INTEGER NOT NULL DEFAULT 0, job_step_payload TEXT NOT NULL DEFAULT '{}')`);
  return { db };
}

function item({ db }, id, status, { owner = 'core-1' } = {}) {
  db.prepare('INSERT INTO item (item_id, item_status, item_owner, item_commit, item_frozen_digest) VALUES (?, ?, ?, ?, ?)').run(id, status, owner, COMMIT, DIGEST);
}

function job({ db }, id, kind, itemId, request, { step = 'offered' } = {}) {
  db.prepare('INSERT INTO job VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, itemId, COMMIT, null, step, AT);
  db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload) VALUES (?, 'offered', ?)").run(id, JSON.stringify({ needs: [], request }));
}

const SUBMIT = { submit: { agentId: 'core-1', digest: DIGEST } };

test('moves.backbone-records.a-gate-job-for-a-claimed-item-is-served: clause 1: a gate job offered for a claimed item at its owner, commit and frozen digest reads served, and unserved naming claimed once the item is withdrawn [C7,#10580]', () => {
  const live = board();
  item(live, 1, 'claimed');
  job(live, 'gate:1', 'gate', 1, SUBMIT);
  assert.deepEqual(readBackboneRecords(live, { since: SINCE }).records, [{ job: 'gate:1', kind: 'gate', item: 1, outcome: 'served' }]);
  live.db.prepare("UPDATE item SET item_status = 'withdrawn' WHERE item_id = 1").run();
  assert.deepEqual(readBackboneRecords(live, { since: SINCE }).records, [{ job: 'gate:1', kind: 'gate', item: 1, outcome: 'unserved', failing: ['claimed'] }]);
});

test('moves.backbone-records.a-missing-input-or-unread-kind-is-unreadable: clause 2: a job of a kind the backbone does not list, and a gate job whose request names no seat, read unreadable with the kind or field named, and nothing throws [C7,#10580]', () => {
  const live = board();
  item(live, 1, 'claimed');
  job(live, 'odd:1', 'odd-kind', 1, SUBMIT);
  job(live, 'gate:1', 'gate', 1, { submit: { digest: DIGEST } });
  job(live, 'gate:bad', 'gate', 1, null);
  live.db.prepare("UPDATE job_step SET job_step_payload = 'not json' WHERE job_step_job = 'gate:bad'").run();
  const { records } = readBackboneRecords(live, { since: SINCE });
  assert.deepEqual(records.map(record => [record.job, record.outcome, record.missing]), [
    ['gate:1', 'unreadable', ['job.seat']], ['gate:bad', 'unreadable', ['job.seat', 'job.digest']], ['odd:1', 'unreadable', ['kind odd-kind']]]);
});

test('moves.backbone-records.the-summary-counts-each-outcome-per-kind: clause 3: backboneSummary counts compared, served, unserved and unreadable per kind, and reading a board file leaves it byte-identical [C7,#10580]', () => {
  const file = join(files.root, 'board.sqlite');
  const fixture = board(file);
  item(fixture, 1, 'claimed');
  item(fixture, 2, 'submitted');
  job(fixture, 'gate:1', 'gate', 1, SUBMIT);
  job(fixture, 'gate:2', 'gate', 2, SUBMIT);
  job(fixture, 'main:1', 'main-test', null, {});
  job(fixture, 'odd:1', 'odd-kind', null, {});
  job(fixture, 'gate:done', 'gate', 1, SUBMIT, { step: 'done' });
  fixture.db.close();
  const before = readFileSync(file);
  const summary = backboneSummary(readBackboneRecords(file, { since: SINCE }).records);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(summary, { compared: 3, served: 2, unserved: 1, unreadable: 1,
    byKind: { gate: { served: 1, unserved: 1, unreadable: 0 }, 'main-test': { served: 1, unserved: 0, unreadable: 0 }, 'odd-kind': { served: 0, unserved: 0, unreadable: 1 } } });
});
