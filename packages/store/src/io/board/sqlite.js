/** Physical SQLite opening accepts explicit runtime ports before migration or proof warming [C7]. */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Refused } from "../../../../kernel/index.js";
import { JOB_SCHEMA_SQL } from "./jobs.js";
import { RUN_SCHEMA_SQL } from "./jobs.js";
import { LEDGER_SCHEMA_SQL } from "./ledger.js";
import { GATE_HOP_SCHEMA_SQL } from "./hop.js";
import { FIELD_SCHEMA_SQL } from "./item/fields.js";
import { RELATED_SCHEMA_SQL } from "./item/related.js";
import { BOARD_WAL_LIMIT_BYTES } from "./checkpoint.js";
import { jobBlobsPending } from "./blobs.js";
import { migrateJobBlobs } from "./blobs.js";
import { ADDITIVE_COLUMNS_SQL } from "./indexes.js";
import { compactBoard } from "./blobs.js";
import { sharedColumnsAhead } from "./schema.js";
import { runsPort } from "./runs.js";
import {
  SCHEMA,
  SCHEMA_VERSION,
  OLDEST_UPGRADABLE_SCHEMA,
  BOARD_TOO_OLD_NEXT,
  SCHEMA_DIGEST,
  EVENT_LOG_VERSION,
  BOARD_BUSY_TIMEOUT_MS,
} from "./schema/source.js";

/** Require connection-local dependencies before creating or touching any SQLite file; never infer a global root. */
export function requireRuntimePorts(ports) {
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) throw new Refused('NO_POLICY', 'Open a native board through its composition root with explicit runtime ports.');
  for (const group of ['guards', 'query', 'auth', 'lifecycle', 'nativePorts', 'enginePorts', 'sourceAdvanceReceipts', 'verification']) {
    if (!ports[group] || typeof ports[group] !== 'object' || Array.isArray(ports[group])) throw new Refused('NO_POLICY', `The native board root must supply its ${group} port group.`);
  }
  for (const name of ['boardReceiptStore', 'readGateReceipt', 'receiptBody', 'receiptFields', 'guardLandingWrite']) {

    if (typeof ports.sourceAdvanceReceipts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply sourceAdvanceReceipts.${name}.`);
  }
  if (!Array.isArray(ports.operations) || ports.operations.some(name => typeof name !== 'string')) throw new Refused('NO_POLICY', 'Supply the native operation names from the move registry.');
  if (typeof ports.logEvent !== 'function') throw new Refused('NO_POLICY', 'The native board root must supply logEvent.');
  for (const name of ['guardStore', 'refreshStoreDeclarations', 'repairDrift', 'storeTriggers']) {
    if (typeof ports.guards[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply guards.${name}.`);
  }
  for (const name of ['atomic', 'normalizeReviewDefaults', 'ensureProofCounters', 'ensureHotIndexes', 'missingAdditiveIndexes', 'ensureAdditiveIndexes', 'configureBoardJournal', 'closeBoardWrites']) {
    if (typeof ports.lifecycle[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply lifecycle.${name}.`);
  }
  for (const name of ['sharedSchemaOwner', 'expectedBoardSchema', 'sharedSchemaDiagnostic', 'reportSharedSchema',
    'boardStanding', 'migrate', 'recordSchemaStamp', 'reportDrift', 'openBoardReadOnly', 'readEventLogVersion', 'migrateEventLogVersion']) {
    if (typeof ports.query[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply query.${name}.`);
  }
  for (const name of ['boardNotWritable', 'boardBusyError']) {
    if (typeof ports.auth[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply auth.${name}.`);
  }
  for (const name of ['agentAt', 'itemById', 'itemCheckBaseline', 'events', 'acceptedVerdict', 'verdictReviewProblem', 'boardId', 'appendRigorCounter', 'ensureRigorCounters', 'withLocalSeatPresence']) {
    if (typeof ports.verification[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply verification.${name}.`);
  }
  for (const name of ['agentModel', 'proofReceipts', 'itemById', 'laneHold', 'laneHolds', 'getItem', 'listAgents', 'reviewHolder', 'listItems', 'seatFamily', 'canonicalFamily',
    'atomic', 'logEvent', 'rowDrafts', 'rowDecisions', 'recordRowDecisions', 'now', 'sourceAdvanceCASProblem', 'beginCommandPhase', 'exportedMeta', 'guardRestore', 'sealSourceAdvanceReturn', 'conflictValue', 'deriveRigorCause', 'recordAutomaticRigorDrafts', 'normalizedDispatch', 'rejectedWorkReturns', 'newRigorNotices', 'rigorNoticeText']) {
    if (typeof ports.nativePorts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply nativePorts.${name}.`);
  }
  for (const name of ['quarantineVerdictSnapshot', 'validateQuarantineGate', 'validateQuarantineLandingProof',
    'validateQuarantineVerdict', 'recordSealedGateRun', 'sealQuarantineVerdict', 'gateRuns', 'requireBound', 'validateQuarantineProofIds']) {
    if (typeof ports.nativePorts.quarantine?.[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply nativePorts.quarantine.${name}.`);
  }
  if (!ports.nativePorts.nextSteps || typeof ports.nativePorts.nextSteps.LANDING_FAILURE_REQUIRED !== 'string') throw new Refused('NO_POLICY', 'The native board root must supply its exact refusal guidance.');
  for (const name of ['requireVerdict', 'requireBatch', 'requireRevision', 'requireTrunk', 'requireStoredBatch']) {
    if (typeof ports.nativePorts.landingEnvironment?.[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply landingEnvironment.${name}.`);
  }
  if (typeof ports.nativePorts.PERSON !== 'string' || !ports.nativePorts.PERSON.trim()) throw new Refused('NO_POLICY', 'The native board root must supply nativePorts.PERSON.');
  if (!ports.enginePorts.store || typeof ports.enginePorts.store.openBoard !== 'function') throw new Refused('NO_POLICY', 'The native board root must supply enginePorts.store.');
  if (!ports.enginePorts.registry || typeof ports.enginePorts.registry !== 'object' || Array.isArray(ports.enginePorts.registry)) throw new Refused('NO_POLICY', 'The native board root must supply enginePorts.registry.');
  for (const name of ['submitHandoffEngines', 'pipelineCauseEngines', 'firstRefusalDetail', 'itemPatchDigest', 'recordFamilyDeclareActivation', 'withDerivedFamily', 'withSeatPresence', 'minimumOperationEngine', 'sealSourceAdvanceReturn', 'sealSourceAdvance', 'sealItemPatchFollow',
    'prepareTrainLanding', 'prepareNativeTrainLanding', 'computedReturnArgs', 'requirePreparedComputedConflict', 'preflightComputedConflict', 'boundProofReceipt', 'sealOwnershipWait',
    'requireOutsideReceipt', 'signedMoveProblem', 'requireCoordinatorHold', 'requireBound',
    'requestMoveProblem', 'recordRequestMove', 'relayPerson', 'requestPerson',
    'personAuthority', 'relayMoveActor', 'relaySenderProblem', 'validRelaySender', 'credentialActor']) {
    if (typeof ports.enginePorts[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply enginePorts.${name}.`);
  }
  for (const name of ['mainPolicy', 'policyAt', 'frozenCheck', 'itemPolicy', 'requireTrunkMerge']) {
    if (typeof ports.enginePorts.sandboxPolicyReads?.[name] !== 'function') throw new Refused('NO_POLICY', `The native board root must supply enginePorts.sandboxPolicyReads.${name}.`);
  }
  if (ports.nativePorts.atomic !== ports.lifecycle.atomic || ports.nativePorts.logEvent !== ports.logEvent
    || ports.enginePorts.operations !== ports.operations) throw new Refused('NO_POLICY', 'Use one canonical set of native and engine providers.');
  return ports;
}

/** The one path of a repository's board database under its git common directory; every other module asks here (registry owner, #6735). */
export function boardFilePath(commonDir) {
  return join(commonDir, 'pullboard/board.sqlite');
}

/** The runs file's name; it always sits in the same folder as the board file (registry owner). */
export const RUNS_FILE = 'board.runs.sqlite';

/** The runs file's own schema stamp; it moves only when the runs file's shape changes. */
export const RUNS_SCHEMA = 1;

/** The board_meta key of the flag that sends runner traffic to the runs file; absent or any value but '1' is off. */
export const RUNS_STORE_KEY = 'runs_store';

/** The path of the runs file that belongs to the board at `boardFile`. */
export function runsFilePath(boardFile) {
  return join(dirname(boardFile), RUNS_FILE);
}

/**
 * Whether this board sends runner traffic to the runs file. Off by default: a board with no flag row reads off.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle.
 * @returns {boolean}
 */
export function runsStoreOn(db) {
  return db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(RUNS_STORE_KEY)?.meta_value === '1';
}

/**
 * Open, or create, a runs file: WAL, the board's busy timeout, the job tables, and a runs_meta stamp naming the board
 * it belongs to. Opening a runs file stamped for another board is refused, so two boards never share one queue.
 *
 * @param {string} file - The runs file, or `:memory:` in tests.
 * @param {{ boardId: string }} options
 * @returns {DatabaseSync}
 */
export function openRunsStore(file, { boardId }) {
  if (typeof boardId !== 'string' || !boardId) throw new Refused('NO_POLICY', 'Name the board a runs file belongs to: pass { boardId }.');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}`);
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS runs_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
    db.exec(JOB_SCHEMA_SQL);
    // The inbox mark lives only in the runs file: set once the board has applied the job's receipt (S5).
    if (!db.prepare('PRAGMA table_info(job)').all().some(column => column.name === 'job_applied')) db.exec('ALTER TABLE job ADD COLUMN job_applied INTEGER');
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare("SELECT meta_value FROM runs_meta WHERE meta_key = 'board_id'").get()?.meta_value;
      if (owner && owner !== boardId) throw new Refused('RUNS_BOARD_MISMATCH', `runs file ${file} belongs to board ${owner}, not ${boardId}`, 'move the stray runs file aside; the board rebuilds in-flight work from its run rows');
      db.prepare("INSERT OR IGNORE INTO runs_meta (meta_key, meta_value) VALUES ('board_id', ?)").run(boardId);
      db.prepare("INSERT INTO runs_meta (meta_key, meta_value) VALUES ('schema', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(RUNS_SCHEMA));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The board's runs port, or null while the flag is off. The runs file opens on the first call, never before, so a
 * board with the flag off never creates one, and no board write ever waits on the runs file's open.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board - An open board.
 * @param {string} boardFile - The board's file path.
 * @returns {ReturnType<typeof runsPort> | null}
 */
export function boardRunsPort(board, boardFile) {
  const holder = boardRunsHolder(board, boardFile);
  return holder ? runsPort(holder) : null;
}

/**
 * The holder of the board's runs handle, or null while the flag is off: `holder.db` opens the runs file on first use and is
 * the same handle after. Why: a machine-local driver keeps the board db for item reads and sends its job rows to this handle [P7,#9080].
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board - An open board.
 * @param {string} boardFile - The board's file path.
 * @returns {{ readonly db: import('node:sqlite').DatabaseSync } | null}
 */
export function boardRunsHolder(board, boardFile) {
  if (!runsStoreOn(board.db)) return null;
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get()?.meta_value;
  let runs = null;
  const open = () => (runs ??= openRunsStore(runsFilePath(boardFile), { boardId }));
  return { get db() { return open(); } };
}

/**
 * The holder of a read-only view of the board's runs file, or null while the flag is off: `holder.db` opens the file on first
 * use and is null when no runs file exists yet. Why: show, trace, stats and the pulled-runner view read runner state without
 * ever creating or writing the runs file, so a reader never takes its write lock or a board write's place [B2,#9013].
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board - An open board.
 * @param {string} boardFile - The board's file path.
 * @returns {{ readonly db: import('node:sqlite').DatabaseSync | null } | null}
 */
export function boardRunsReader(board, boardFile) {
  if (!runsStoreOn(board.db)) return null;
  const file = runsFilePath(boardFile);
  let runs;
  const open = () => (runs === undefined ? (runs = existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null) : runs);
  return { get db() { return open(); } };
}

/**
 * Refuse a board made before the release this one upgrades from, before any write [R4].
 * A read-only look at PRAGMA user_version, so the file stays byte-identical; 0 is a new, empty file.
 *
 * @param {string} file
 * @param {{ query: { openBoardReadOnly: Function } }} runtimePorts
 */
function refuseBoardBeyondOneRelease(file, runtimePorts) {
  if (file === ':memory:' || !existsSync(file)) return;
  let version = 0;
  let current;
  try {
    current = runtimePorts.query.openBoardReadOnly(file);
    version = current.prepare('PRAGMA user_version').get().user_version;
  } catch {
    return;
  } finally {
    current?.close();
  }
  if (version > 0 && version < OLDEST_UPGRADABLE_SCHEMA) {
    throw new Refused('BOARD_TOO_OLD', `this board is schema ${version}, from before pullboard 0.9.3; pullboard supports one release back, and nothing was changed`, BOARD_TOO_OLD_NEXT);
  }
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
  const { guardStore, refreshStoreDeclarations, repairDrift, storeTriggers } = runtimePorts.guards;
  const { atomic, ensureProofCounters, warmFamilyProjection, familyProjectionCurrent, ensureHotIndexes, missingAdditiveIndexes, ensureAdditiveIndexes } = runtimePorts.lifecycle;
  const { sharedSchemaOwner, expectedBoardSchema, sharedSchemaDiagnostic, reportSharedSchema,
    boardStanding, migrate, recordSchemaStamp, reportDrift, openBoardReadOnly, readEventLogVersion,
    migrateEventLogVersion } = runtimePorts.query;
  const { boardNotWritable, boardBusyError } = runtimePorts.auth;
  const { configureBoardJournal, closeBoardWrites } = runtimePorts.lifecycle;
  isMain = sharedSchemaOwner(file, isMain);
  refuseBoardBeyondOneRelease(file, runtimePorts);
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
    db.exec(`PRAGMA busy_timeout = ${BOARD_BUSY_TIMEOUT_MS}; PRAGMA journal_size_limit = ${BOARD_WAL_LIMIT_BYTES}`);
    if (file !== ':memory:' && isMain !== false) configureBoardJournal(db, writeContext);
    const board = { db, clock, writeContext, gitRoot, onDiagnostic, runtimePorts, nativePorts: runtimePorts.nativePorts, enginePorts: runtimePorts.enginePorts };
    let warmCounters = true;
    if (isMain !== false || file === ':memory:') {
      // Migrate and audit only a board whose version is behind; a drifted shape gets only repairDrift's safe repair (#1047, #5825).
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
      }, { reviewPolicy: false });
      if (refreshStoreDeclarations(board)) standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION);
      // A drifted board still gains additive tables, and its guards and stamp when the rest of its shape matches (#5825).
      if (standing === 'drifted' && repairDrift(board)) standing = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION);
      // Index-only upgrades keep the data version/digest unchanged. Install and restamp together;
      // drifted or read-only stores never take this path, and old clients accept the resulting stamp.
      if (standing !== 'drifted' && missingAdditiveIndexes(db)) atomic(board, () => {
        if (boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION) !== 'current') return;
        ensureAdditiveIndexes(db);
        recordSchemaStamp(db, SCHEMA_DIGEST);
      }, { reviewPolicy: false });
      if (standing !== 'drifted') settleJobBlobs(db, onDiagnostic);
      if (standing === 'drifted') { warmCounters = false; reportDrift(file, onDiagnostic); }
    } else {
      // Read compatibility before any local effect; persistent schema belongs to trunk alone.
      readEventLogVersion(db);
      // The opt-in item-field tables count as known too, so a board with typed fields is not newer than this code [C7,#9351].
      // The opt-in hop table counts as known: a board whose gate took a fenced hop is not newer than this code [C7,#8327].
      const expected = expectedBoardSchema(`${SCHEMA}${JOB_SCHEMA_SQL}${RUN_SCHEMA_SQL}${LEDGER_SCHEMA_SQL};${GATE_HOP_SCHEMA_SQL};${FIELD_SCHEMA_SQL};${RELATED_SCHEMA_SQL};${ADDITIVE_COLUMNS_SQL}`, migrate, storeTriggers);
      // Code behind trunk refuses before any write: carrying on replayed newer caches under the lock for minutes (#5899).
      const ahead = sharedColumnsAhead(db, expected);
      if (ahead.length) {
        throw new Refused('UNMERGED_SCHEMA', `this code is older than the shared board, which has ${ahead.length} column${ahead.length === 1 ? '' : 's'} it does not know (${ahead.slice(0, 3).join(', ')}${ahead.length > 3 ? ', ...' : ''}); an old writer must not change a newer board`,
          'run the main checkout\'s pullboard (the pullboard on your PATH), or merge main into this worktree, then retry');
      }
      reportSharedSchema(file, sharedSchemaDiagnostic(db, expected), onDiagnostic);
    }
    guardMoves(board);
    // Writable commands catch up old writers or missing local projections once. Read-only open
    // never calls this path; drifted stores remain untouched, and invalid history stays invalid.
    // Proof warming also preserves the Rigor projection, including after a proof-cache rebuild.
    // Only a board whose counters or family projection are behind takes the write lock here;
    // a current one opens with no write at all (#2578).
    if (warmCounters) {
      const countersCold = !board.nativePorts.currentProofCounters?.(board);
      const familyCold = !!warmFamilyProjection && !familyProjectionCurrent?.(board);
      if (countersCold || familyCold) atomic(board, () => {
        if (countersCold) ensureProofCounters(board, { refresh: false });
        if (familyCold) warmFamilyProjection(board);
      }, { reviewPolicy: false });
    }
    return board;
  } catch (error) {
    try { db?.close(); if (db) closeBoardWrites(db); } catch { /* Preserve the opening failure when SQLite cleanup also fails. */ }
    throw boardNotWritable(file, boardBusyError(file, startedAt, error));
  }
}

/**
 * Run the one-time job blob move and the compaction it earns, never failing the open: a board that cannot do either now
 * (busy, no disk room) opens as it is and tries again on a later open.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {((line: string) => void) | undefined} onDiagnostic
 */
function settleJobBlobs(db, onDiagnostic) {
  try {
    if (!jobBlobsPending(db)) return;
    const moved = migrateJobBlobs(db);
    if (moved.moved || moved.pruned) onDiagnostic?.(`job payloads: ${moved.moved} moved to blobs, ${moved.pruned} old copies pruned`);
    const compact = compactBoard(db);
    if (compact.compacted) onDiagnostic?.(`board compacted: ${compact.before} to ${compact.after} bytes`);
  } catch (error) { onDiagnostic?.(`job payload move deferred: ${error?.message ?? error}`); }
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

