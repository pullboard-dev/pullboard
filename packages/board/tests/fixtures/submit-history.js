/** @pullboard-world-pin reads the recorded submit history fixture and replays it through the moves reader, through the moves front door; copied from the store cell fixture so a board test imports no store test helper. */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readSubmitRecords } from '../../../moves/index.js';

export const HISTORY = JSON.parse(readFileSync(new URL('../../../moves/tests/fixtures/table/submit-history.json', import.meta.url), 'utf8'));

/** The recorded events on a scratch in-memory board, read the way the replay reads them. */
export function recorded() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_lane TEXT, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_parent_id INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT);
    CREATE TABLE shout (shout_id INTEGER PRIMARY KEY, shout_from TEXT, shout_to TEXT, shout_text TEXT);
    CREATE TABLE job (job_id INTEGER PRIMARY KEY, job_kind TEXT, job_item INTEGER);
    CREATE TABLE job_step (job_step_id INTEGER PRIMARY KEY, job_step_job INTEGER, job_step_payload TEXT)`);
  const insert = (sql, rows) => { const statement = db.prepare(sql); for (const row of rows) statement.run(...row); };
  insert('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)', HISTORY.events.map(([id, at, by, kind, item, detail]) => [id, at, by, kind, item, JSON.stringify(detail)]));
  insert('INSERT INTO agent VALUES (?, ?, ?)', HISTORY.agents);
  insert('INSERT INTO item VALUES (?, ?)', HISTORY.parents);
  insert('INSERT INTO board_meta VALUES (?, ?)', HISTORY.outside);
  insert('INSERT INTO shout VALUES (?, ?, ?, ?)', HISTORY.shouts);
  insert('INSERT INTO job VALUES (?, ?, ?)', [...new Set(HISTORY.jobSteps.map(([item]) => item))].map(item => [item, 'gate', item]));
  insert('INSERT INTO job_step VALUES (?, ?, ?)', HISTORY.jobSteps.map(([item, payload], i) => [i + 1, item, payload]));
  return readSubmitRecords({ db }, { since: HISTORY.since });
}
