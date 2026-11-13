import { COORDINATOR } from '../queue/light.js';
import { Refused } from '../kernel/light.js';
export { receiptFields, runTimingFields, sameEnvironment, testRuntimeEnvironment, testRuntimeRows } from './src/logic/proof/provenance.js';

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

const LANE_TEST_PART = /^(?:node --test|node (?:bin\/run-tests|(?:packages\/gate|apps\/cli)\/src\/io\/run\/tests)\.js)(?: --test-force-exit)?((?: [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.js)+)$/u;

/**
 * The test files of a check that is only `node --test` or `node apps/cli/src/io/run/tests.js` over plain .test.js paths, joined by &&;
 * null for any other check. Why: a lane seat may file such a check over files its lane owns [C7,#2908]; the CLI proves ownership.
 */
export function laneCheckFiles(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const files = [];
  for (const part of command.trim().split(' && ')) {
    const match = LANE_TEST_PART.exec(part);
    if (!match) return null;
    files.push(...match[1].trim().split(' '));
  }
  return files.some(file => file.split('/').includes('..')) ? null : files;
}

/** Refuse a seat's check when any named test file belongs to another lane; `laneOf(config, file)` is the caller's ownership port. */
export function requireOwnLaneCheck(config, me, lane, check, laneOf) {
  if (check === undefined || me.id === COORDINATOR) return;
  const files = laneCheckFiles(check);
  if (!files) return;
  for (const file of files) {
    const owner = laneOf(config, file);
    if (owner !== lane || (me.lane && me.lane !== lane)) {
      throw new Refused('LANE_CHECK_FOREIGN', `${file} belongs to ${owner === COORDINATOR ? 'the coordinator' : `lane ${owner}`}, not lane ${lane}; a lane seat's check names test files its own lane owns`,
        `shout ${owner === COORDINATOR ? 'coordinator' : owner} to set a check that names ${file}`);
    }
  }
}

/** Normalize an explicitly supplied check when its author is the coordinator, or a seat naming only test files [V2,C7]. */
export function coordinatorCheck(agentId, command) {
  if (command === undefined) return undefined;
  if (agentId !== COORDINATOR && typeof command === 'string' && laneCheckFiles(command)) return command.trim();
  if (agentId !== COORDINATOR) {
    throw new Refused('COORDINATOR_CHECK', 'only the coordinator sets or edits an item check; ask your coordinator to supply --check');
  }
  if (typeof command !== 'string') throw new Refused('BAD_CHECK', 'an item check is a command string; ask your coordinator to supply --check "<command>"');
  return command.trim();
}

