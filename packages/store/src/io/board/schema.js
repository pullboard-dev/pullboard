/** Compare a worktree's declaration with shared trunk schema without changing it [A5,A6,C7]. */
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  codeIsFromMain,
  codeUsesRepository,
} from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";

const reported = new Set();

/** Identify the repository-shared board without treating arbitrary private test files as shared. */
export function isRepositoryBoard(file) {
  if (file === ':memory:') return false;
  const canonical = existsSync(file) ? realpathSync(file) : resolve(file);
  const parent = dirname(canonical);
  return basename(canonical) === 'board.sqlite' && basename(parent) === 'pullboard'
    && existsSync(join(dirname(parent), 'HEAD'));
}

/** Read declared column shapes and persistent machine triggers; TEMP guards are connection-local. */
export function boardSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const columns = new Map();
  for (const { name } of tables) {
    for (const row of db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all()) {
      columns.set(`${name}.${row.name}`, JSON.stringify([row.type, row.notnull, row.dflt_value, row.pk]));
    }
  }
  const triggers = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine%' ORDER BY name")
    .all().map(row => [row.name, row.sql]));
  return { columns, triggers };
}

/** Materialize this code's declaration only in memory, never in the repository-shared database. */
export function declaredBoardSchema(initialize) {
  const db = new DatabaseSync(':memory:');
  try { initialize(db); return boardSchema(db); }
  finally { db.close(); }
}

/** The tables a board makes on first use, not in its schema. */
const OPT_IN_TABLE = /^(?:gate_hop|field_decl|item_field|item_related)\./u;

/** List exact missing, extra, and changed declarations (the opt-in gate hop table may be absent) in one actionable compatibility notice. */
export function sharedSchemaDiagnostic(db, expected) {
  const actual = boardSchema(db);
  const differences = [];
  for (const kind of ['columns', 'triggers']) {
    const label = kind === 'columns' ? 'column' : 'trigger';
    for (const [name, value] of expected[kind]) {
      // The gate hop, item-field and related-item tables are opt-in: a board gains each on first use, so its absence is no drift [C7,#8327,#9351].
      if (!actual[kind].has(name)) { if (!OPT_IN_TABLE.test(name)) differences.push(`${label} only in this worktree: ${name}`); }
      else if (actual[kind].get(name) !== value) differences.push(`different ${label}: ${name}`);
    }
    for (const name of actual[kind].keys()) {
      if (!expected[kind].has(name)) differences.push(`${label} only in shared board: ${name}`);
    }
  }
  return differences.length ? `[SHARED_SCHEMA_DIFFERENCE] ${differences.join('; ')}. Continuing with the shared board's trunk schema and triggers; merge schema changes into the main checkout before installing them.` : null;
}

/**
 * List the shared board's columns this code does not declare: code older than trunk. Why: an old writer that carries
 * on resets and replays newer derived caches under the write lock, which held every seat for minutes (#5899).
 */
export function sharedColumnsAhead(db, expected) {
  return [...boardSchema(db).columns.keys()].filter(name => !expected.columns.has(name));
}

/** Send a fallback notice once per shared board and declaration in a long-lived non-CLI process. */
export function reportSharedSchema(file, diagnostic, onDiagnostic) {
  if (!diagnostic) return;
  const key = resolve(file) + '\n' + diagnostic;
  if (onDiagnostic) onDiagnostic(diagnostic);
  else if (!reported.has(key)) process.stderr.write(`pullboard: ${diagnostic}\n`);
  reported.add(key);
  if (reported.size > 128) reported.delete(reported.values().next().value);
}


const declarations = new WeakMap();

/** Resolve schema ownership independently of caller hints, while permitting fresh private fixtures. */
export function sharedSchemaOwner(file, hint) {
  let owner = isRepositoryBoard(file) ? hint !== false && codeIsFromMain() : hint;
  if (file !== ':memory:' && owner === false && !existsSync(file)) {
    // Unmerged source cannot initialize its own shared board. A separate fresh project has no
    // existing schema to replace, even when it created linked worktrees before its first command.
    const commonDir = dirname(dirname(file));
    if (isRepositoryBoard(file) && existsSync(join(commonDir, 'worktrees')) && codeUsesRepository(commonDir)) {
      throw new Refused('UNMERGED_SCHEMA', 'the shared board is missing; run pullboard status from the main checkout to initialize it before using this worktree');
    }
    owner = true;
  }
  return owner;
}

/** Cache the complete source declaration without running any DDL on the shared connection. */
export function expectedBoardSchema(schema, migrate, triggers) {
  if (!declarations.has(migrate)) {
    declarations.set(migrate, declaredBoardSchema(db => {
      db.exec(schema);
      migrate(db);
      for (const { sql } of triggers()) db.exec(sql);
    }));
  }
  return declarations.get(migrate);
}
