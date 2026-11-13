/**
 * Every board API query on job, job_step and event reaches its table through an index, never a SCAN,
 * on a board with the trunk's indexes installed [C7]. It reads the real source statements and plans each.
 */
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';

/** The packages whose source answers the board API: job offers, claims, receipts, runner capacity and the grant check. */
const API_JOB_SOURCES = ['packages/api/src/io', 'packages/runners/src/io', 'packages/jobs/src/io', 'packages/state/src/logic/grant.js'];

/** Every statement in the given source that reads or writes job or job_step, with ${...} parts stood in by a constant. */
function jobStatements(root) {
  const found = new Map();
  const files = [];
  const walk = (path) => {
    if (path.endsWith('.js')) return files.push(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (!entry.name.startsWith('.')) walk(join(path, entry.name));
  };
  for (const source of API_JOB_SOURCES) walk(join(root, source));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/gu)) {
      const sql = (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/gu, '1').replace(/\s+/gu, ' ').trim();
      if (/^(?:SELECT|UPDATE|DELETE|INSERT)\b/u.test(sql) && /\b(?:FROM|JOIN|UPDATE|INTO)\s+job(?:_step)?\b/iu.test(sql)) found.set(sql, file);
    }
  }
  return found;
}

test('clause 1: board API queries on job, job_step and event never scan their table [C7]', (t) => {
  const board = cellBoard(t, ':memory:', { now: () => new Date('2026-11-12T00:00:00.000Z') });
  const statements = jobStatements(resolve(import.meta.dirname, '../../../..'));
  assert.ok(statements.size > 25, `only ${statements.size} job statements were found`);
  // The commands run worktree code that never changes a shared board's schema, so the board gets the trunk's indexes here.
  const db = board.db;
  {
    store.ensureJobTables(db);
    store.ensureHotIndexes(db);
    const scans = [];
    for (const [sql, file] of statements) {
      const names = new Set(['job', 'job_step', 'event', 'step', 'j', 's']);
      const bindings = Array.from(sql.matchAll(/\?/gu), () => null);
      let plan;
      try { plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail); } catch { continue; }
      const scanned = plan.filter((detail) => {
        const match = /^(?:SCAN (\w+)|SEARCH (\w+) USING AUTOMATIC)/u.exec(detail);
        return match && names.has(match[1] ?? match[2]);
      });
      if (scanned.length) scans.push(`${file.split('/packages/').pop()}: ${sql.slice(0, 200)}\n    ${plan.join('\n    ')}`);
    }
    assert.deepEqual(scans, [], `${scans.length} board API statements scan job, job_step or event:\n${scans.join('\n')}`);
  }
});
