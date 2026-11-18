/** Bounded runner admission and read-only overdue queue status [C7,Q1,Q2]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machineHome } from '../../../resources/light.js';
import { Refused } from '../../../kernel/light.js';

/** Read current overdue runs without creating or migrating the resource pool. */
export function runnerDeadlineRuns() {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare('PRAGMA table_info(waiter)').all().some(column => column.name === 'runner_deadline')) return [];
    return db.prepare("SELECT agent, repo, item, kind, since, runner_deadline AS at, runner_wait_branch AS branch, runner_wait_reasons AS reasons FROM waiter WHERE name='gate' AND runner_deadline > 0 AND runner_deadline <= ? AND heartbeat >= ? ORDER BY ticket")
      .all(Date.now(), Date.now() - 20_000).map(({ reasons, ...run }) => ({ ...run, runners: JSON.parse(reasons) }));
  } catch (error) {
    if (['EACCES', 'EPERM', 'SQLITE_BUSY', 'SQLITE_CANTOPEN'].includes(error.code)
      || error.code === 'ERR_SQLITE_ERROR' && [5, 14].includes(error.errcode & 0xff)) return null;
    throw error;
  } finally { db?.close(); }
}
