/** Read-only integrity checks for a pullboard board file (A6). */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BLANKS, STATES, storeTriggers } from './machine.js';

import { SCHEMA_VERSION } from './board.js';
const blankCharacters = new Set(BLANKS.map((point) => String.fromCodePoint(point)));

/**
 * Check a board and its git pins without opening it through the migrator, which repairs boards on
 * open. `doctor` must report the evidence it sees and leave that evidence untouched.
 *
 * @param {string} file
 * @param {string} root
 * @param {(root: string, args: string[]) => { status: number, stdout: string }} tryGit
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function doctorProblems(file, root, tryGit) {
  if (!existsSync(file)) return [finding('BOARD_MISSING', 'board file is missing', 'run pullboard status to create a new board')];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schemaProblems = versionProblems(db);
    if (schemaProblems.length) return schemaProblems;
    const layout = layoutProblems(db);
    return [
      ...triggerProblems(db),
      ...layout.problems,
      ...(layout.itemFields ? itemProblems(db) : []),
      ...(layout.itemPins ? pinProblems(db, root, tryGit) : []),
      ...(layout.verdicts ? verdictProblems(db, root, tryGit) : []),
    ];
  } finally {
    db.close();
  }
}

/**
 * Make one stable finding for both text and JSON output.
 *
 * @param {string} code
 * @param {string} message
 * @param {string} next
 * @returns {{ code: string, message: string, next: string }}
 */
const finding = (code, message, next) => ({ code, message, next });

/** Inspect the layout before each row check, retaining trigger findings on an incomplete board. */
function layoutProblems(db) {
  const required = {
    item: [...new Set(['item_id', 'item_status', 'item_commit', ...STATES.flatMap((state) => state.requires)])],
    verdict: ['verdict_id', 'item_id', 'verdict_commit'],
  };
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((table) => table.name));
  const columns = new Map();
  const problems = [];
  for (const [table, fields] of Object.entries(required)) {
    if (!tables.has(table)) {
      problems.push(finding('TABLE_MISSING', `board table ${table} is missing`, 'restore a consistent board backup, or run pullboard status to recreate the missing table'));
      columns.set(table, new Set());
      continue;
    }
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    columns.set(table, present);
    const missing = fields.filter((field) => !present.has(field));
    if (missing.length) problems.push(finding('COLUMN_MISSING', `board table ${table} is missing columns ${missing.join(', ')}`, 'restore a consistent board backup, then run pullboard status'));
  }
  const has = (table, fields) => fields.every((field) => columns.get(table).has(field));
  return {
    problems,
    itemFields: has('item', ['item_id', 'item_status']),
    itemPins: has('item', ['item_id', 'item_status', 'item_commit']),
    verdicts: has('verdict', required.verdict),
  };
}

/**
 * Report a schema version this executable cannot safely use.
 *
 * @param {DatabaseSync} db
 * @returns {{ code: string, message: string, next: string }[]}
 */
function versionProblems(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === SCHEMA_VERSION) return [];
  const repair = version < SCHEMA_VERSION
    ? 'run pullboard status to upgrade this board'
    : 'use a pullboard version that supports this board schema';
  return [finding('SCHEMA_VERSION', `schema version is ${version}; this pullboard expects ${SCHEMA_VERSION}`, repair)];
}

/**
 * Report missing, changed or undeclared lifecycle triggers and how the normal opener repairs them.
 *
 * @param {DatabaseSync} db
 * @returns {{ code: string, message: string, next: string }[]}
 */
function triggerProblems(db) {
  const expected = storeTriggers();
  const actual = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all().map((row) => [row.name, row.sql]));
  const problems = [];
  for (const trigger of expected) {
    const sql = actual.get(trigger.name);
    if (sql === undefined) problems.push(finding('TRIGGER_MISSING', `board trigger ${trigger.name} is missing`, 'run pullboard status'));
    else if (sql !== trigger.sql) problems.push(finding('TRIGGER_CHANGED', `board trigger ${trigger.name} has changed`, 'run pullboard status'));
  }
  for (const name of actual.keys()) {
    if (!expected.some((trigger) => trigger.name === name)) problems.push(finding('TRIGGER_UNEXPECTED', `board trigger ${name} is unexpected`, 'run pullboard status'));
  }
  return problems;
}

/**
 * Report item rows missing fields required by their current state.
 *
 * @param {DatabaseSync} db
 * @returns {{ code: string, message: string, next: string }[]}
 */
function itemProblems(db) {
  const required = new Map(STATES.map((state) => [state.id, state.requires]));
  const problems = [];
  for (const item of db.prepare('SELECT * FROM item ORDER BY item_id').all()) {
    const fields = required.get(item.item_status) ?? [];
    const missing = fields.filter((field) => [...String(item[field] ?? '')].every((character) => blankCharacters.has(character)));
    if (missing.length) problems.push(finding('ITEM_FIELDS', `item #${item.item_id} (${item.item_status}) is missing ${missing.join(', ')}`, 'restore a consistent board backup, then run pullboard doctor'));
  }
  return problems;
}

/**
 * Report submitted or verified items whose saved commit pin no longer resolves.
 *
 * @param {DatabaseSync} db
 * @param {string} root
 * @param {(root: string, args: string[]) => { status: number, stdout: string }} tryGit
 * @returns {{ code: string, message: string, next: string }[]}
 */
function pinProblems(db, root, tryGit) {
  const items = db.prepare("SELECT item_id, item_commit FROM item WHERE item_status IN ('submitted', 'verified') ORDER BY item_id").all();
  return items.flatMap((item) => {
    const commit = item.item_commit ?? '';
    const pin = `refs/pullboard/items/${item.item_id}/${commit.slice(0, 12)}`;
    const found = commit && tryGit(root, ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`]);
    if (found?.status === 0 && found.stdout === commit) return [];
    return [finding('ITEM_PIN_MISSING', `item #${item.item_id} has no pin for ${commit || 'its missing commit'} at ${pin}`, `fetch the commit if needed, then run git update-ref ${pin} ${commit || '<commit>'}`)];
  });
}

/**
 * Report verdict receipts whose commit object is no longer in the repository.
 *
 * @param {DatabaseSync} db
 * @param {string} root
 * @param {(root: string, args: string[]) => { status: number, stdout: string }} tryGit
 * @returns {{ code: string, message: string, next: string }[]}
 */
function verdictProblems(db, root, tryGit) {
  return db.prepare('SELECT verdict_id, item_id, verdict_commit FROM verdict ORDER BY verdict_id').all().flatMap((verdict) => {
    const found = tryGit(root, ['rev-parse', '--verify', '--quiet', `${verdict.verdict_commit}^{commit}`]);
    if (found.status === 0 && found.stdout === verdict.verdict_commit) return [];
    const pin = `refs/pullboard/items/${verdict.item_id}/${verdict.verdict_commit.slice(0, 12)}`;
    return [finding('VERDICT_COMMIT_MISSING', `verdict #${verdict.verdict_id} for item #${verdict.item_id} names missing commit ${verdict.verdict_commit}`, `fetch the commit if needed, then run git update-ref ${pin} ${verdict.verdict_commit}`)];
  });
}
