import { COORDINATOR } from '../queue/core.js';
import { Refused } from '../kernel/index.js';

/** Normalize bounded per-test facts; malformed or duplicate identities grant no quarantine evidence. */
export function testOutcomeFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100000) return null;
  const keys = new Set(), rows = [];
  for (const row of value) {
    if (!row || Object.keys(row).sort().join(',') !== 'file,name,passed,skipped'
      || typeof row.file !== 'string' || !row.file || row.file.length > 4096
      || row.file.startsWith('/') || /^[A-Za-z]:/u.test(row.file) || /[\\\r\n\0]/u.test(row.file)
      || row.file.split('/').some(part => !part || part === '.' || part === '..')
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || /[\r\n\0]/u.test(row.name)
      || typeof row.passed !== 'boolean' || typeof row.skipped !== 'boolean') return null;
    const key = JSON.stringify([row.file, row.name]);
    if (keys.has(key)) return null;
    keys.add(key);
    rows.push({ file: row.file, name: row.name, passed: row.passed, skipped: row.skipped });
  }
  return rows;
}

/** Normalize an explicitly supplied check only when its author is the coordinator [V2]. */
export function coordinatorCheck(agentId, command) {
  if (command === undefined) return undefined;
  if (agentId !== COORDINATOR) {
    throw new Refused('COORDINATOR_CHECK', 'only the coordinator sets or edits an item check; ask your coordinator to supply --check');
  }
  if (typeof command !== 'string') throw new Refused('BAD_CHECK', 'an item check is a command string; ask your coordinator to supply --check "<command>"');
  return command.trim();
}

