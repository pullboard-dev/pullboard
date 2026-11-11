/** Read-only custody evidence prevents stale maintenance from releasing a claim during a native run [B4,Q1]. */
import {
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machineHome } from '../../../../../resources/index.js';

/** Any matching retained holder prevents proving silence; this observer never prunes another process's custody. */
export function staleRunQuiet(repo, identity = null) {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return true;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='holder'").get()) return false;
    const columns = db.prepare('PRAGMA table_info(holder)').all().map(column => column.name);
    if (!columns.includes('repo')) return false;
    if (identity) {
      if (!columns.includes('item') || !columns.includes('agent')) return false;
      if (db.prepare('SELECT 1 FROM holder WHERE item=? AND agent=? LIMIT 1').get(identity.item, identity.agent)) return false;
    }
    const target = realpathSync(repo);
    const roots = new Set([target, ...(identity?.roots ?? [])]);
    for (const row of db.prepare('SELECT DISTINCT repo FROM holder').all()) {
      try { if (roots.has(realpathSync(row.repo))) return false; }
      catch { if (roots.has(row.repo) || row.repo === repo) return false; }
    }
    return true;
  } catch { return false; }
  finally { db?.close(); }
}
