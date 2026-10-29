/** Read-only custody evidence prevents stale maintenance from releasing a claim during a native run [B4,Q1]. */
import {
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machineHome } from '../../../../src/machine-home.js';

/** Any matching retained holder prevents proving silence; this observer never prunes another process's custody. */
export function staleRunQuiet(repo) {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return true;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='holder'").get()) return false;
    const columns = db.prepare('PRAGMA table_info(holder)').all().map(column => column.name);
    if (!columns.includes('repo')) return false;
    const target = realpathSync(repo);
    for (const row of db.prepare('SELECT DISTINCT repo FROM holder').all()) {
      try { if (realpathSync(row.repo) === target) return false; }
      catch { if (row.repo === repo) return false; }
    }
    return true;
  } catch { return false; }
  finally { db?.close(); }
}
