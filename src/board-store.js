/** Physical SQLite opening accepts explicit runtime ports before migration or proof warming [C7]. */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refused } from './refused.js';
import {
  SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_DIGEST,
  EVENT_LOG_VERSION,
  BOARD_BUSY_TIMEOUT_MS,
} from './board-schema-source.js';

/** Require connection-local dependencies before creating or touching any SQLite file; never infer a global root. */
export function requireRuntimePorts(ports) {
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) throw new Refused('NO_POLICY', 'Open a native board through its composition root with explicit runtime ports.');
  for (const group of ['guards', 'query', 'auth', 'lifecycle', 'nativePorts', 'enginePorts', 'sourceAdvanceReceipts', 'verification']) {
    if (!ports[group] || typeof ports[group] !== 'object' || Array.isArray(ports[group])) throw new Refused('NO_POLICY', `The native board root must supply its ${group} port group.`);
  }
  for (const name of ['boardReceiptStore', 'readGateReceipt', 'receiptBody', 'guardLandingWrite']) {
    if (typeof ports.sourceAdvanceReceipts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply sourceAdvanceReceipts.${name}.`);
  }
  if (!Array.isArray(ports.operations) || ports.operations.some(name => typeof name !== 'string')) throw new Refused('NO_POLICY', 'Supply the native operation names from the move registry.');
  if (typeof ports.logEvent !== 'function') throw new Refused('NO_POLICY', 'The native board root must supply logEvent.');
  for (const name of ['guardStore', 'refreshStoreDeclarations', 'storeTriggers']) {
    if (typeof ports.guards[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply guards.${name}.`);
  }
  for (const name of ['atomic', 'ensureProofCounters', 'ensureHotIndexes', 'missingAdditiveIndexes', 'ensureAdditiveIndexes', 'configureBoardJournal', 'closeBoardWrites']) {
    if (typeof ports.lifecycle[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply lifecycle.${name}.`);
  }
  for (const name of ['sharedSchemaOwner', 'expectedBoardSchema', 'sharedSchemaDiagnostic', 'reportSharedSchema',
    'boardStanding', 'migrate', 'recordSchemaStamp', 'reportDrift', 'openBoardReadOnly', 'readEventLogVersion', 'migrateEventLogVersion']) {
    if (typeof ports.query[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply query.${name}.`);
  }
  for (const name of ['boardNotWritable', 'boardBusyError']) {
    if (typeof ports.auth[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply auth.${name}.`);
  }
  for (const name of ['agentAt', 'itemById', 'itemCheckBaseline', 'events', 'acceptedVerdict', 'verdictReviewProblem', 'boardId', 'appendRigorCounter', 'ensureRigorCounters']) {
    if (typeof ports.verification[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply verification.${name}.`);
  }
  for (const name of ['atomic', 'logEvent', 'rowDrafts', 'rowDecisions', 'recordRowDecisions', 'now']) {
    if (typeof ports.nativePorts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply nativePorts.${name}.`);
  }
  if (typeof ports.nativePorts.PERSON !== 'string' || !ports.nativePorts.PERSON.trim()) throw new Refused('NO_POLICY', 'The native board root must supply nativePorts.PERSON.');
  if (!ports.enginePorts.store || typeof ports.enginePorts.store.openBoard !== 'function') throw new Refused('NO_POLICY', 'The native board root must supply enginePorts.store.');
  if (!ports.enginePorts.registry || typeof ports.enginePorts.registry !== 'object' || Array.isArray(ports.enginePorts.registry)) throw new Refused('NO_POLICY', 'The native board root must supply enginePorts.registry.');
  for (const name of ['withSeatPresence', 'minimumOperationEngine', 'sealSourceAdvanceReturn', 'sealSourceAdvance', 'sealItemPatchFollow',
    'prepareTrainLanding', 'prepareNativeTrainLanding', 'computedReturnArgs', 'requirePreparedComputedConflict', 'preflightComputedConflict', 'boundProofReceipt',
    'requireOutsideReceipt', 'signedMoveProblem', 'requireCoordinatorHold', 'requireBound',
    'requestMoveProblem', 'recordRequestMove', 'relayPerson', 'requestPerson',
    'personAuthority', 'relayMoveActor', 'relaySenderProblem', 'validRelaySender', 'credentialActor']) {
    if (typeof ports.enginePorts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply enginePorts.${name}.`);
  }
  if (ports.nativePorts.atomic !== ports.lifecycle.atomic || ports.nativePorts.logEvent !== ports.logEvent
    || ports.enginePorts.operations !== ports.operations) throw new Refused('NO_POLICY', 'Use one canonical set of native and engine providers.');
  return ports;
}

/**
 * Open, or create, the board at `file`. Tests pass `:memory:`.
 *
 * The busy timeout comes first, so a second process opening the board at the same moment waits for
 * the lock instead of failing.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @param {{ ports: object, isMain?: boolean, onDiagnostic?: (message: string) => void, writeContext?: {command?:string, seat?:string, path?:string}, gitRoot?: string }} [options] Only main upgrades schema; gitRoot is a local verification port, never replicated metadata.
 * @returns {{ db: DatabaseSync, clock: { now: () => Date } }}
 */
export function openBoardStore(file, clock, { isMain, onDiagnostic, writeContext, gitRoot, ports } = {}) {
  const runtimePorts = requireRuntimePorts(ports);
  if (!clock || typeof clock.now !== 'function') throw new Refused('NO_POLICY', 'Supply the native board clock before opening storage.');
  const { guardStore, refreshStoreDeclarations, storeTriggers } = runtimePorts.guards;
  const { atomic, ensureProofCounters, ensureHotIndexes, missingAdditiveIndexes, ensureAdditiveIndexes } = runtimePorts.lifecycle;
  const { sharedSchemaOwner, expectedBoardSchema, sharedSchemaDiagnostic, reportSharedSchema,
    boardStanding, migrate, recordSchemaStamp, reportDrift, openBoardReadOnly, readEventLogVersion,
    migrateEventLogVersion } = runtimePorts.query;
  const { boardNotWritable, boardBusyError } = runtimePorts.auth;
  const { configureBoardJournal, closeBoardWrites } = runtimePorts.lifecycle;
  isMain = sharedSchemaOwner(file, isMain);
  if (file !== ':memory:' && isMain === false) {
    let boardVersion = 0;
    let logVersion = 0;
    if (existsSync(file)) {
      const startedAt = Date.now();
      let current;
      try {
        current = openBoardReadOnly(file);
        boardVersion = current.prepare('PRAGMA user_version').get().user_version;
        logVersion = readEventLogVersion(current);
      } catch (error) {
        throw boardNotWritable(file, boardBusyError(file, startedAt, error));
      } finally {
        current?.close();
      }
      if (SCHEMA_VERSION > boardVersion) {
        throw new Refused(
          'UNMERGED_SCHEMA',
          `this worktree expects board schema ${SCHEMA_VERSION}, newer than the shared board's version ${boardVersion}; merge this code into the main checkout first, or test it against a throwaway board`,
        );
      }
      if (EVENT_LOG_VERSION > logVersion) {
        throw new Refused('UNMERGED_SCHEMA', `this worktree expects event log ${EVENT_LOG_VERSION}, newer than the shared board's version ${logVersion}; merge this code into the main checkout first, or test it against a throwaway board`);
      }
    }
  }
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const startedAt = Date.now();
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}`);
    if (file !== ':memory:' && isMain !== false) configureBoardJournal(db, writeContext);
    const board = { db, clock, writeContext, gitRoot, onDiagnostic, runtimePorts, nativePorts: runtimePorts.nativePorts, enginePorts: runtimePorts.enginePorts };
    let warmCounters = true;
    if (isMain !== false || file === ':memory:') {
      // Migrate and audit only a board whose version is behind; a drifted shape is reported and left alone (#1047).
      let standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION, readEventLogVersion(db) < EVENT_LOG_VERSION);
      if (standing === 'behind' || standing === 'unstamped') atomic(board, () => {
        if (standing === 'behind') {
          migrateEventLogVersion(db);
          migrate(db);
          ensureHotIndexes(db);
          db.prepare('INSERT OR IGNORE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('board_id', randomBytes(16).toString('hex'));
          guardStore(board);
        }
        recordSchemaStamp(db, SCHEMA_DIGEST);
      });
      if (refreshStoreDeclarations(board)) standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION);
      // Index-only upgrades keep the data version/digest unchanged. Install and restamp together;
      // drifted or read-only stores never take this path, and old clients accept the resulting stamp.
      if (standing !== 'drifted' && missingAdditiveIndexes(db)) atomic(board, () => {
        if (boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION) !== 'current') return;
        ensureAdditiveIndexes(db);
        recordSchemaStamp(db, SCHEMA_DIGEST);
      });
      if (standing === 'drifted') { warmCounters = false; reportDrift(file, onDiagnostic); }
    } else {
      // Read compatibility before any local effect; persistent schema belongs to trunk alone.
      readEventLogVersion(db);
      reportSharedSchema(file, sharedSchemaDiagnostic(db, expectedBoardSchema(SCHEMA, migrate, storeTriggers)), onDiagnostic);
    }
    guardMoves(board);
    // Writable commands catch up old writers or missing local projections once. Read-only open
    // never calls this path; drifted stores remain untouched, and invalid history stays invalid.
    // Proof warming also preserves the Rigor projection, including after a proof-cache rebuild.
    if (warmCounters) atomic(board, () => ensureProofCounters(board));
    return board;
  } catch (error) {
    try { db?.close(); if (db) closeBoardWrites(db); } catch { /* Preserve the opening failure when SQLite cleanup also fails. */ }
    throw boardNotWritable(file, boardBusyError(file, startedAt, error));
  }
}

/**
 * Make this connection refuse any change to an item's status that does not come through moveItem
 * (M1). A TEMP trigger, which lives only in this process's connection, lets the status column
 * change only while moveItem holds a token in a TEMP table, so a status written anywhere else in
 * this code, however it is spelled, is refused by SQLite itself. Recursive triggers stay on, so a
 * REPLACE INTO, which deletes the old row first, meets the board file's own delete trigger. An
 * agent's own connection never sees these TEMP objects; the board file's triggers (M3) govern it.
 *
 * @param {any} board
 */
function guardMoves(board) {
  board.db.exec(`
    PRAGMA recursive_triggers = ON;
    CREATE TEMP TABLE IF NOT EXISTS moving (token INTEGER);
    CREATE TEMP TRIGGER IF NOT EXISTS status_through_moves BEFORE UPDATE OF item_status ON main.item
    WHEN NOT EXISTS (SELECT 1 FROM temp.moving)
    BEGIN SELECT RAISE(ABORT, 'STATUS_OUTSIDE_MOVE: only moveItem in src/board.js changes an item''s status'); END;
  `);
}

