/** Read current local-memory queue holds without opening or migrating the resource database [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  machineHome,
  machineSettingsFile,
} from "../../../resources/light.js";
import { readMachineSettingsFile } from "../../../queue/index.js";

/** An unset floor keeps status on its existing lightweight path; old pools have no per-run holds. */
export function memoryHeldRuns() {
  if (readMachineSettingsFile(machineSettingsFile())?.gate?.memoryFloorMB === undefined) return [];
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare('PRAGMA table_info(waiter)').all().some(column => column.name === 'memory_held')) return [];
    return db.prepare("SELECT agent, repo, item, kind, since FROM waiter WHERE name='gate' AND memory_held=1 AND heartbeat >= ? ORDER BY ticket")
      .all(Date.now() - 20_000);
  } catch (error) {
    if (['EACCES', 'EPERM', 'SQLITE_BUSY', 'SQLITE_CANTOPEN'].includes(error.code)
      || error.code === 'ERR_SQLITE_ERROR' && [5, 14].includes(error.errcode & 0xff)) return null;
    throw error;
  } finally { db?.close(); }
}
