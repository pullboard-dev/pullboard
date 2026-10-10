/**
 * The board (B1–B7, V1–V8, R1, R2): items, claims, submissions, verdicts and shouts in one SQLite
 * file in the git common dir, so every worktree sees the same board and nothing is committed.
 *
 * Every move is one immediate transaction (B2), so two agents can never claim the same item, and
 * every move lands in an append-only event log (R2). The caller supplies what only git and the
 * spec know: the commit, the verifier's checkout, the frozen criterion.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { briefFiles, briefSections } from './brief.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION, GUARDS, IN_STATE, MOVES, STATES, UNKNOWN_MOVE, effectiveGuards, storeTriggers } from './machine.js';
import { Refused } from './refused.js';
import { parseSpec } from './spec.js';

export const ACCEPT_REASON = 'CRITERION_MET';
export const PERSON = 'person';

/** Version of the persisted append-only event record format; bump for incompatible format changes. */
export const EVENT_LOG_VERSION = 1;

/**
 * Who can take an item (B13), as tiers in order of the model an item needs: `light` is work a small
 * or local model can build from its brief, `mid` needs a capable general model, and
 * `strong` needs a frontier model's judgment. An agent's route is set when it joins; it takes items
 * at its tier and below.
 */
export const ROUTES = ['light', 'mid', 'strong'];
const BRIEF_LIMIT = 8000;
const REVIEW_RELEASE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * True when an agent on `agentRoute` may build or verify an item routed `itemRoute`.
 *
 * @param {string} agentRoute
 * @param {string} itemRoute
 * @returns {boolean}
 */
export const canTake = (agentRoute, itemRoute) => ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute);
export const REJECT_REASONS = [
  'TEST_FAILURE',
  'BEHAVIOR_MISMATCH',
  'INSUFFICIENT_EVIDENCE',
  'STALE_HEAD',
  'OTHER',
];

/**
 * The clock the board reads, real unless a test passes its own.
 */
export const systemClock = { now: () => new Date() };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_meta (
    meta_key TEXT PRIMARY KEY,
    meta_value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent (
    agent_id TEXT PRIMARY KEY,
    agent_lane TEXT NOT NULL,
    agent_path TEXT NOT NULL UNIQUE,
    agent_last_shout_id INTEGER NOT NULL DEFAULT 0,
    agent_route TEXT NOT NULL DEFAULT 'strong',
    agent_family TEXT,
    agent_created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS item (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_parent_id INTEGER REFERENCES item (item_id),
    item_lane TEXT NOT NULL,
    item_title TEXT NOT NULL,
    item_criterion TEXT NOT NULL DEFAULT '',
    item_spec_ids TEXT NOT NULL DEFAULT '',
    item_after TEXT NOT NULL DEFAULT '',
    item_brief TEXT NOT NULL DEFAULT '',
    item_route TEXT NOT NULL DEFAULT 'strong',
    item_check TEXT NOT NULL DEFAULT '',
    item_status TEXT NOT NULL DEFAULT 'open',
    item_owner TEXT,
    item_lease_until TEXT,
    item_frozen TEXT,
    item_frozen_digest TEXT,
    item_built_by TEXT,
    item_builder_family TEXT,
    item_commit TEXT,
    item_tree TEXT,
    item_verdict TEXT,
    item_verified_by TEXT,
    item_merged_commit TEXT,
    item_withdrawn_reason TEXT,
    item_hold_reason TEXT,
    item_hold_by TEXT,
    item_hold_at TEXT,
    item_created_by TEXT NOT NULL,
    item_created_at TEXT NOT NULL,
    item_updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS item_lane_status ON item (item_lane, item_status);
  CREATE TABLE IF NOT EXISTS verdict (
    verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES item (item_id),
    verdict_by TEXT NOT NULL,
    verdict_verifier_family TEXT,
    verdict_decision TEXT NOT NULL,
    verdict_reason TEXT NOT NULL,
    verdict_note TEXT NOT NULL DEFAULT '',
    verdict_commit TEXT NOT NULL,
    verdict_digest TEXT NOT NULL,
    verdict_head TEXT NOT NULL,
    verdict_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shout (
    shout_id INTEGER PRIMARY KEY AUTOINCREMENT,
    shout_from TEXT NOT NULL,
    shout_to TEXT NOT NULL,
    shout_text TEXT NOT NULL,
    shout_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_at TEXT NOT NULL,
    event_by TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    item_id INTEGER,
    event_detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS hold (
    hold_lane TEXT PRIMARY KEY,
    hold_reason TEXT NOT NULL,
    hold_by TEXT NOT NULL,
    hold_at TEXT NOT NULL
  );
`;

/**
 * Open, or create, the board at `file`. Tests pass `:memory:`.
 *
 * The busy timeout comes first, so a second process opening the board at the same moment waits for
 * the lock instead of failing.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @returns {{ db: DatabaseSync, clock: { now: () => Date } }}
 */
export function openBoard(file, clock = systemClock) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrateEventLogVersion(db);
    migrate(db);
    db.prepare('INSERT OR IGNORE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('board_id', randomBytes(16).toString('hex'));
    const board = { db, clock };
    guardStore(board);
    guardMoves(board);
    return board;
  } catch (error) {
    db.close();
    throw error;
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

/** The board's PRAGMA user_version once its triggers are in: losing one after that is news. */
export const SCHEMA_VERSION = 2;
const GUARDED = 1;

/**
 * Install the triggers that make the board file refuse what the lifecycle does not allow (M3), and
 * put back any that are missing or differ from the declaration. A board that never had them is just
 * older and gets them quietly; a board that had them and lost one was edited by hand, so the event
 * log says which came back.
 *
 * @param {any} board
 */
function guardStore(board) {
  const wanted = storeTriggers();
  const drift = () => {
    const have = new Map(
      board.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all().map((row) => [row.name, row.sql]),
    );
    return {
      missing: wanted.filter(({ name }) => !have.has(name)).map(({ name }) => name),
      changed: wanted.filter(({ name, sql }) => have.has(name) && have.get(name) !== sql).map(({ name }) => name),
      stale: [...have.keys()].filter((name) => !wanted.some((trigger) => trigger.name === name)),
    };
  };
  const isWhole = ({ missing, changed, stale }) => !missing.length && !changed.length && !stale.length;
  if (isWhole(drift())) {
    if (board.db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) board.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  atomic(board, () => {
    const found = drift();
    if (isWhole(found)) return;
    for (const name of [...found.changed, ...found.stale]) board.db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    for (const { name, sql } of wanted) if (found.missing.includes(name) || found.changed.includes(name)) board.db.exec(sql);
    if (board.db.prepare('PRAGMA user_version').get().user_version >= GUARDED) logEvent(board, 'board', 'guards', null, found);
    if (board.db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) board.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * Bring a board made by an older version up to the current schema, one added column at a time, so
 * an upgrade never needs a fresh board.
 *
 * @param {DatabaseSync} db
 */
function migrate(db) {
  const added = [
    ['item', 'item_after', "TEXT NOT NULL DEFAULT ''"],
    ['item', 'item_brief', "TEXT NOT NULL DEFAULT ''"],
    ['item', 'item_route', "TEXT NOT NULL DEFAULT 'strong'"],
    ['item', 'item_check', "TEXT NOT NULL DEFAULT ''"],
    ['agent', 'agent_route', "TEXT NOT NULL DEFAULT 'strong'"],
    ['agent', 'agent_family', 'TEXT'],
    ['item', 'item_builder_family', 'TEXT'],
    ['verdict', 'verdict_verifier_family', 'TEXT'],
    ['item', 'item_claim_head', 'TEXT'],
    ['item', 'item_files', "TEXT NOT NULL DEFAULT ''"],
    ['item', 'item_review_by', 'TEXT'],
    ['item', 'item_review_until', 'TEXT'],
    ['item', 'item_hold_reason', 'TEXT'],
    ['item', 'item_hold_by', 'TEXT'],
    ['item', 'item_hold_at', 'TEXT'],
    ['shout', 'shout_decision', 'INTEGER NOT NULL DEFAULT 0'],
    ['shout', 'shout_answers', 'INTEGER'],
    ['shout', 'shout_evidence_kind', 'TEXT'],
    ['shout', 'shout_evidence_outcome', 'TEXT'],
    ['shout', 'shout_evidence_item', 'INTEGER'],
    ['shout', 'shout_evidence_commit', 'TEXT'],
    ['shout', 'shout_request', 'INTEGER NOT NULL DEFAULT 0'],
    ['shout', 'shout_request_outcome', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, column, type] of added) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Read the persisted event format without migrating it, so integrity checks enforce the same
 * compatibility rule as the writable opener while leaving older or damaged evidence intact.
 *
 * @param {DatabaseSync} db
 * @returns {number}
 */
export function readEventLogVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_meta'").get()) return 0;
  const stored = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version');
  const version = stored && /^(?:0|[1-9]\d*)$/u.test(stored.meta_value) ? Number(stored.meta_value) : stored ? NaN : 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${stored?.meta_value ?? 'missing'} is invalid; restore a valid board or upgrade pullboard`);
  }
  if (version > EVENT_LOG_VERSION) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${version} is newer than this pullboard version ${EVENT_LOG_VERSION}; upgrade pullboard to open this board`);
  }
  return version;
}

/** Refuse unknown future event records before migrating anything, and mark older boards current. */
function migrateEventLogVersion(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    const version = readEventLogVersion(db);
    if (version < EVENT_LOG_VERSION) {
      db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
        .run('event_log_version', String(EVENT_LOG_VERSION));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The persistent local and relay identity of this board (A2). */
export function boardId(board) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_id').meta_value;
}

/**
 * Close the board's file.
 *
 * @param {{ db: DatabaseSync }} board
 */
export function closeBoard(board) {
  board.db.close();
}

/**
 * The board's time as ISO text.
 *
 * @param {any} board
 * @returns {string}
 */
const now = (board) => board.clock.now().toISOString();

const TRANSACTION_DEPTH = new WeakMap();

/**
 * Run `work` in one immediate transaction: the write lock is taken before the first read, so two
 * agents can never both see an item as free (B2). Nested moves use savepoints so a replay receipt
 * and its board mutation can commit together, while a refused move rolls back only its work.
 *
 * @template T
 * @param {any} board
 * @param {() => T} work
 * @returns {T}
 */
export function atomic(board, work) {
  const depth = TRANSACTION_DEPTH.get(board) ?? 0;
  const savepoint = `pullboard_atomic_${depth}`;
  board.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  TRANSACTION_DEPTH.set(board, depth + 1);
  const lastEvent = board.lastEvent;
  const emitted = board.emittedEvents?.length ?? 0;
  try {
    const result = work();
    board.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    board.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    board.lastEvent = lastEvent;
    board.emittedEvents?.splice(emitted);
    throw error;
  } finally {
    TRANSACTION_DEPTH.set(board, depth);
  }
}

/**
 * Append one move to the event log (R2), retaining its exact row for an API response (A2).
 *
 * @param {any} board
 * @param {string} by
 * @param {string} kind
 * @param {number | null} itemId
 * @param {object} [detail]
 */
function logEvent(board, by, kind, itemId, detail = {}) {
  const inserted = board.db
    .prepare(
      'INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)',
    )
    .run(now(board), by, kind, itemId, JSON.stringify(detail));
  board.lastEvent = board.db.prepare('SELECT * FROM event WHERE event_id = ?').get(inserted.lastInsertRowid);
  (board.emittedEvents ??= []).push(board.lastEvent);
}

/** Log an authenticated relay refusal without making an item, shout or verdict move [H2,H16]. */
export function recordRelayRefusal(board, { by, sequence, kind, operation, actor, code }) {
  logEvent(board, by, 'relay_refused', null, { sequence, kind, operation, actor, code });
}

/**
 * The item with this id, or a refusal naming the id.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function itemById(board, id) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
  if (!item) throw new Refused('NO_ITEM', `no item #${id}; see: pullboard list`);
  return item;
}

/**
 * Write some of an item's fields, and its updated time. Field names come from this module only.
 *
 * @param {any} board
 * @param {number} id
 * @param {Record<string, string | number | null>} fields
 */
function setItem(board, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  board.db
    .prepare(`UPDATE item SET ${sets}, item_updated_at = ? WHERE item_id = ?`)
    .run(...keys.map((key) => fields[key]), now(board), id);
}

/**
 * True while someone holds the item under a lease that has not lapsed.
 *
 * @param {any} board
 * @param {any} item
 * @returns {boolean}
 */
function isHeld(board, item) {
  return item.item_status === 'claimed' && (item.item_lease_until ?? '') > now(board);
}

/**
 * The item as a reader should see it: a claim whose lease lapsed reads as open (B4).
 *
 * @param {any} board
 * @param {any} item
 * @returns {any}
 */
function current(board, item) {
  if (item.item_status !== 'claimed' || isHeld(board, item)) return { ...item };
  return { ...item, item_status: 'open', item_owner: null, item_lease_until: null };
}

/**
 * The agent registered for a worktree path, if any.
 *
 * @param {any} board
 * @param {string} path
 * @returns {any}
 */
export function agentAt(board, path) {
  return board.db.prepare('SELECT * FROM agent WHERE agent_path = ?').get(path);
}

/**
 * Register a worktree as an agent (B3): the main checkout as the one coordinator, any other
 * worktree as the next agent in its lane (`web-1`, `web-2`, ...), on a route: the tier of model
 * behind it, which decides the items it may take (B13). The optional family is free text supplied
 * by the agent; the board neither names nor infers it. Registering again preserves the agent id;
 * an explicitly supplied family updates the declaration, while omission preserves it.
 *
 * @param {any} board
 * @param {{ lane: string, path: string, route?: string, family?: string | null }} who
 * @returns {string} The agent's id.
 */
export function register(board, { lane, path, route = 'strong', family }) {
  checkRoute(route);
  if (lane === COORDINATOR && route !== 'strong') {
    throw new Refused('BAD_ROUTE', 'the coordinator plans, merges and verifies; it is always strong');
  }
  return atomic(board, () => {
    const existing = agentAt(board, path);
    if (existing) {
      if (existing.agent_lane !== lane || existing.agent_route !== route) {
        throw new Refused(
          'ALREADY_JOINED',
          `this worktree is ${existing.agent_id} in the ${existing.agent_lane} lane, routed ${existing.agent_route}; use another worktree for ${lane} routed ${route}`,
        );
      }
      if (family !== undefined && family !== existing.agent_family) {
        board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(family, existing.agent_id);
        logEvent(board, existing.agent_id, 'family', null, { family });
      }
      return existing.agent_id;
    }
    const { total } = board.db
      .prepare('SELECT COUNT(*) AS total FROM agent WHERE agent_lane = ?')
      .get(lane);
    if (lane === COORDINATOR && total > 0) {
      throw new Refused('ONE_COORDINATOR', 'the coordinator is the main checkout; it already has one');
    }
    const id = lane === COORDINATOR ? COORDINATOR : `${lane}-${total + 1}`;
    board.db
      .prepare(
        'INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_family, agent_created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, lane, path, route, family ?? null, now(board));
    logEvent(board, id, 'join', null, route === 'strong' ? { lane } : { lane, route });
    return id;
  });
}

/**
 * The coordinator, registered at the main checkout. Only the main checkout of this repo can reach
 * this board, so when the repo moved on disk the coordinator follows it instead of refusing.
 *
 * @param {any} board
 * @param {string} path
 * @returns {string}
 */
export function ensureCoordinator(board, path) {
  const existing = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(COORDINATOR);
  if (!existing) return register(board, { lane: COORDINATOR, path });
  if (existing.agent_path !== path) {
    atomic(board, () => {
      board.db.prepare('UPDATE agent SET agent_path = ? WHERE agent_id = ?').run(path, COORDINATOR);
      logEvent(board, COORDINATOR, 'moved', null, { path });
    });
  }
  return COORDINATOR;
}

/**
 * Every registered agent, oldest first.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function listAgents(board) {
  return board.db.prepare('SELECT * FROM agent ORDER BY rowid').all();
}

/**
 * Refuse a route that is not one of ROUTES.
 *
 * @param {string} route
 */
function checkRoute(route) {
  if (!ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is light (a small or local model can build it from the brief), mid (a capable model) or strong (a frontier model)`);
  }
}

/**
 * Refuse an item a lighter model could not build cold (B10, B14). Any brief stays short enough to
 * read. Below the strong route the item needs all of it: a criterion, a check command that proves
 * it, and a brief naming the files and the test.
 *
 * @param {{ brief: string, route: string, criterion: string, check: string }} item
 */
function checkRouted({ brief, route, criterion, check }) {
  if (brief.length > BRIEF_LIMIT) {
    throw new Refused('BRIEF_TOO_LONG', `the brief is ${brief.length} characters; keep it under ${BRIEF_LIMIT} and point to longer docs by path`);
  }
  if (route === 'strong') return;
  const sections = briefSections(brief);
  const missing = [
    ...(briefFiles(brief).length ? [] : ['a brief with a Files: section naming the paths to touch']),
    ...(sections.test?.length ? [] : ['a Test: section saying what the test asserts']),
    ...(criterion.trim() ? [] : ['--criterion, saying when it is done']),
    ...(check.trim() ? [] : ['--check, the command that proves it']),
  ];
  if (missing.length) {
    throw new Refused('NO_BRIEF', `an item routed ${route} must be buildable cold; it needs ${missing.join(', ')}`);
  }
}

/**
 * The route an agent joined on; strong for the coordinator and for ids the board does not know.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {string}
 */
function routeOf(board, agentId) {
  return board.db.prepare('SELECT agent_route FROM agent WHERE agent_id = ?').get(agentId)?.agent_route ?? 'strong';
}

/**
 * Add an item to a lane, optionally under a parent in the same lane, with a brief for whoever
 * builds it and a route saying who can (B10, B11). The caller has checked the lane and the spec
 * ids (B6).
 *
 * @param {any} board
 * @param {{ by: string, lane: string, title: string, criterion?: string, specIds?: string[], parentId?: number | null, after?: number[], brief?: string, route?: string, check?: string }} item
 * @returns {number} The new item's id.
 */
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong', check, checkBaseline }) {
  return atomic(board, () => {
    const { command, cleanTitle } = validateItemAddition(board, { by, lane, title, criterion, parentId, after, brief, route, check });
    const baseline = normalizeCheckBaseline(by, command, checkBaseline);
    const at = now(board);
    const result = board.db
      .prepare(
        `INSERT INTO item (item_parent_id, item_lane, item_title, item_criterion, item_spec_ids,
           item_after, item_brief, item_route, item_check, item_created_by, item_created_at, item_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(parentId, lane, cleanTitle, criterion.trim(), specIds.join(','), after.join(','), brief.trim(), route, command, by, at, at);
    const id = Number(result.lastInsertRowid);
    saveCheckBaseline(board, id, baseline);
    logEvent(board, by, 'add', id, { lane, specIds, after, route, ...(baseline ? { checkBaseline: baseline } : {}) });
    return id;
  });
}

/** Validate an addition before its sender runs a new check, and again when the ordered move applies. */
export function validateItemAddition(board, { by, lane, title, criterion = '', parentId = null, after = [], brief = '', route = 'strong', check }) {
  const command = coordinatorCheck(by, check) ?? '';
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  checkRouted({ brief: brief.trim(), route, criterion, check: command });
  if (parentId !== null) {
    const parent = itemById(board, parentId);
    if (parent.item_lane !== lane) {
      throw new Refused('PARENT_LANE', `a child item sits in its parent's lane (${parent.item_lane})`);
    }
    if (['verified', 'withdrawn'].includes(parent.item_status)) {
      throw new Refused('PARENT_CLOSED', `item #${parentId} is ${parent.item_status}`);
    }
  }
  for (const dependency of after) {
    if (itemById(board, dependency).item_status === 'withdrawn') {
      throw new Refused('WITHDRAWN', `item #${dependency} is withdrawn; nothing can wait on it`);
    }
  }
  return { command, cleanTitle };
}

/**
 * Change an item's brief, route, criterion or check (B10, B13, B14). The brief says how to build it
 * and may change until the item is verified or withdrawn. The route, the criterion and the check
 * change only while nobody holds the item; changing the criterion or the check drops the frozen
 * bar, so the next claim freezes the new one, in the log for anyone to see. The coordinator or the
 * agent that added the item may edit it.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, brief?: string, route?: string, criterion?: string, check?: string }} change
 */
export function editItem(board, id, { agentId, brief, route, criterion, check, checkBaseline }) {
  atomic(board, () => {
    const stored = itemById(board, id);
    const expiredHolder = stored.item_status === 'claimed' && !isHeld(board, stored) ? stored.item_owner : null;
    const { item, next, command, unfreeze } = validateItemEdit(board, id, { agentId, brief, route, criterion, check });
    const baseline = normalizeCheckBaseline(agentId, command, checkBaseline);
    const clearFrozen = unfreeze || Boolean(expiredHolder);
    if (expiredHolder) {
      moveItem(board, id, 'lapse', { checks: {}, set: () => ({ item_owner: null, item_lease_until: null }) });
    }
    setItem(board, id, { ...next, ...(clearFrozen ? { item_frozen: null, item_frozen_digest: null } : {}) });
    if (baseline || next.item_check !== item.item_check) saveCheckBaseline(board, id, baseline);
    logEvent(board, agentId, 'edit', id, {
      ...(next.item_brief !== item.item_brief ? { brief: `${next.item_brief.length} characters` } : {}),
      ...(next.item_route !== item.item_route ? { route: next.item_route } : {}),
      ...(next.item_criterion !== item.item_criterion ? { criterion: next.item_criterion } : {}),
      ...(command !== undefined ? { check: next.item_check } : {}),
      ...(baseline ? { checkBaseline: baseline } : {}),
      ...(clearFrozen && item.item_frozen_digest ? { unfrozen: item.item_frozen_digest } : {}),
      ...(expiredHolder ? { expiredHolder } : {}),
    });
  });
}

/** Validate an edit without side effects, so a refused change never starts a shell baseline. */
export function validateItemEdit(board, id, { agentId, brief, route, criterion, check }) {
  const command = coordinatorCheck(agentId, check);
  if ([brief, route, criterion, check].every((value) => value === undefined)) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --brief-file <file>, --route light|mid|strong, --criterion "..." or --check "<command>"');
  }
  const item = current(board, itemById(board, id));
  if (agentId !== COORDINATOR && agentId !== item.item_created_by) {
    throw new Refused('NOT_YOURS', `only the coordinator or ${item.item_created_by}, who added #${id}, edits it; shout them instead`);
  }
  if (['verified', 'withdrawn'].includes(item.item_status)) {
    throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
  }
  const next = {
    item_brief: brief === undefined ? item.item_brief : brief.trim(),
    item_route: route ?? item.item_route,
    item_criterion: criterion === undefined ? item.item_criterion : criterion.trim(),
    item_check: command === undefined ? item.item_check : command,
  };
  checkRoute(next.item_route);
  const moved = ['item_route', 'item_criterion', 'item_check'].filter((key) => next[key] !== item[key]);
  if (moved.length && item.item_status !== 'open') {
    throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route, criterion or check only while it is open`);
  }
  checkRouted({ brief: next.item_brief, route: next.item_route, criterion: next.item_criterion, check: next.item_check });
  const unfreeze = next.item_criterion !== item.item_criterion || next.item_check !== item.item_check;
  return { item, next, command, unfreeze };
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

/** Validate captured baseline data without asking a replica to run Git or a shell [V2,H16]. */
function normalizeCheckBaseline(agentId, command, baseline) {
  if (baseline === undefined) return undefined;
  coordinatorCheck(agentId, command ?? '');
  if (!command || !baseline || typeof baseline !== 'object' || Array.isArray(baseline)
    || baseline.command !== command || !['green', 'red', 'unavailable', 'pending'].includes(baseline.result)
    || !(baseline.main === null || typeof baseline.main === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.main))
    || (baseline.result !== 'unavailable' && baseline.main === null)
    || (baseline.result === 'pending' && !baseline.request)
    || (baseline.request !== undefined && (typeof baseline.request !== 'string' || !/^[a-f0-9-]{36}$/.test(baseline.request)))
    || (baseline.reason !== undefined && typeof baseline.reason !== 'string')
    || (baseline.seconds !== undefined && (!Number.isSafeInteger(baseline.seconds) || baseline.seconds < 0))) {
    throw new Refused('BAD_CHECK_BASELINE', 'the check baseline must describe this command at a main commit; set --check again from the coordinator');
  }
  return {
    command, main: baseline.main, result: baseline.result,
    ...(baseline.request === undefined ? {} : { request: baseline.request }),
    ...(baseline.reason === undefined ? {} : { reason: baseline.reason }),
    ...(baseline.seconds === undefined ? {} : { seconds: baseline.seconds }),
    ...(baseline.result === 'green' ? { warning: 'CRITERION_PROVES_NOTHING' } : {}),
  };
}

/** Record a captured result only for the still-current authorized background request [V2,H16]. */
export function completeCheckBaseline(board, id, { agentId, expected, baseline }) {
  return atomic(board, () => {
    const result = normalizeCheckBaseline(agentId, baseline?.command, baseline);
    if (!expected || !result || result.result === 'pending' || result.command !== expected.command || result.main !== expected.main
      || typeof expected.request !== 'string' || !/^[a-f0-9-]{36}$/.test(expected.request)) {
      throw new Refused('BAD_CHECK_BASELINE', 'a completed baseline must match its authorized request; set --check again from the coordinator');
    }
    const item = itemById(board, id);
    const current = itemCheckBaseline(board, item);
    if (current?.result !== 'pending' || current.request !== expected.request || current.command !== expected.command || current.main !== expected.main) return false;
    const recorded = { ...result, request: expected.request };
    saveCheckBaseline(board, id, recorded);
    logEvent(board, agentId, 'check-baseline', id, { checkBaseline: recorded });
    return true;
  });
}

/** Store or clear an item's observation atomically with its check and immutable audit event. */
function saveCheckBaseline(board, id, baseline) {
  const key = `item_check_baseline_${id}`;
  if (!baseline) board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(key);
  else board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(baseline));
}

/** Read an observation only when it still describes the item's current check command. */
function itemCheckBaseline(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_check_baseline_${item.item_id}`);
  if (!row) return null;
  const baseline = JSON.parse(row.meta_value);
  return baseline.command === item.item_check ? baseline : null;
}

/** Read the current check's setter from immutable edits, or its original item author [V2]. */
export function itemCheckAuthor(board, id) {
  const item = itemById(board, id);
  const edits = board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'edit' ORDER BY event_id DESC").all(id);
  for (const edit of edits) {
    let detail;
    try { detail = JSON.parse(edit.event_detail); }
    catch { return null; }
    if (detail && Object.hasOwn(detail, 'check')) return detail.check === item.item_check ? edit.event_by : null;
  }
  return item.item_created_by;
}

/**
 * The refusal codes src/machine.js declares for a guard of a move: the guard's own and any
 * additional typed refusals, or for the state check, the move's.
 *
 * @param {any} move
 * @param {string} id
 * @returns {string[]}
 */
function declaredCodes(move, id) {
  if (id === IN_STATE) return [move.refuse];
  const guard = GUARDS.find((entry) => entry.id === id);
  return [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)];
}

/**
 * Apply one declared move to an item (M1, M2). This is the only code that writes an item's status.
 *
 * It checks the move's guards, then any exit guard of its target the move does not name, in the
 * order src/machine.js declares them, and refuses with the first that does not hold. `checks` has
 * one entry per guard: a function given the item that returns null when the guard holds or the
 * refusal when it does not, or null for a guard the caller has already checked, such as the CLI's
 * look at git and the gate. The item's state is checked against the move's declared starting
 * states; its entry supplies only the refusal. Each refusal must carry the code the declaration
 * gives that guard, so the code here and the declaration cannot drift apart. Once every guard
 * holds, `before` runs, for what must exist before the write, such as the verdict that proves an
 * accept; then the target state's fields are checked and the status written with `set`.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} verb
 * @param {{ checks: Record<string, ((item: any) => Refused | null) | null>, set?: (item: any) => object, before?: (item: any) => void }} how
 * @returns {any} The item as it was before the move.
 */
function moveItem(board, id, verb, { checks, set = () => ({}), before = () => {} }) {
  const move = MOVES.find((entry) => entry.verb === verb);
  if (!move) throw new Refused(UNKNOWN_MOVE.refuse, `${UNKNOWN_MOVE.rule}: ${UNKNOWN_MOVE.next}`);
  let item = null;
  for (const guard of effectiveGuards(move)) {
    if (guard === 'itemExists') {
      item = itemById(board, id);
      continue;
    }
    if (!(guard in checks)) throw new Error(`move ${verb}: guard ${guard} has no check`);
    const check = checks[guard];
    if (check === null) continue;
    if (guard === IN_STATE && move.from.includes(item.item_status)) continue;
    const refusal = check(item);
    if (refusal === null) continue;
    const codes = declaredCodes(move, guard);
    if (!codes.includes(refusal.code)) {
      throw new Error(`move ${verb}: guard ${guard} refused with ${refusal.code}; the declaration says ${codes.join(' or ')}`);
    }
    throw refusal;
  }
  before(item);
  const fields = { ...set(item), item_status: move.to };
  const requires = STATES.find((state) => state.id === move.to).requires;
  const missing = requires.filter((field) => !String({ ...item, ...fields }[field] ?? '').trim());
  if (missing.length) throw new Error(`move ${verb}: ${move.to} needs ${missing.join(', ')}`);
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try {
    setItem(board, id, fields);
  } finally {
    board.db.exec('DELETE FROM temp.moving');
  }
  return item;
}

/**
 * The refusal when the caller is not the coordinator, or null when it is.
 *
 * @param {string} agentId
 * @param {string} what
 * @returns {Refused | null}
 */
const onlyCoordinator = (agentId, what) => (agentId === COORDINATOR ? null : new Refused('COORDINATOR_ONLY', `only the coordinator ${what}`));

/**
 * Hand an item one tier up (B15): its builder could not get it green, so it goes back open, routed
 * to the next stronger model, with what was tried pinned and why it failed in the log. A strong
 * item stays strong and goes back to the coordinator's attention.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, attempt?: string }} why
 * @returns {{ from: string, to: string }}
 */
export function escalate(board, id, { agentId, note, attempt = '' }) {
  return atomic(board, () => {
    const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];
    const item = moveItem(board, id, 'escalate', {
      checks: {
        joined: null,
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'say what was tried and how it failed: --note "..."')),
        holderOrCoordinator: (found) => {
          const live = current(board, found);
          const isHolder = live.item_status === 'claimed' && live.item_owner === agentId;
          return isHolder || agentId === COORDINATOR ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator escalates it`);
        },
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${current(board, found).item_status}; escalate open or claimed work only`),
      },
      set: (found) => ({ item_route: nextRoute(found.item_route), item_owner: null, item_lease_until: null }),
    });
    const from = item.item_route;
    const to = nextRoute(from);
    logEvent(board, agentId, 'escalate', id, { from, to, note: note.trim(), ...(attempt ? { attempt } : {}) });
    return { from, to };
  });
}

/**
 * Record one unattended attempt at an item (A11): which try, how long, and how it ended, so each
 * route's record shows whether its tier pays.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, n: number, seconds: number, result: string }} attempt
 */
export function recordAttempt(board, id, { agentId, n, seconds, result }) {
  logEvent(board, agentId, 'attempt', id, { n, seconds, result });
}

/**
 * Claim an item, or renew your own claim (B4, B5, B12, V2).
 *
 * One live top-level claim per agent, so nobody hoards; child items are free, which is how
 * sub-agents share a lane. A lapsed claim can be taken. Every item is built in its own lane, the
 * coordinator's included, so no agent can build another lane's work from the main checkout. The
 * first claim freezes the criterion: `freeze` returns the text and digest the verdict will later be
 * held to. A fresh claim also records `head`, the commit the work starts from, so submit can name
 * the files the item changed (N21). A held lane takes no new claims (N22); renewals go on.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string }, head?: string | null, reviewSkipped?: object | null }} who
 * @returns {{ leaseUntil: string, digest: string, renewed: boolean }}
 */
export function claim(board, id, { agentId, lane, leaseMs, freeze, head = null, reviewSkipped = null }) {
  return atomic(board, () => {
    const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
    const isRenewal = (item) => item.item_owner === agentId && isHeld(board, item);
    // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
    // builder fixing what a verifier found need not drop its other work to do it.
    const isRework = (item) => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
    let frozen = null;
    const item = moveItem(board, id, 'claim', {
      checks: {
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_CLAIMABLE', `item #${id} is ${found.item_status}`),
        inLane: (found) => {
          if (found.item_lane === lane) return null;
          return new Refused(
            'WRONG_LANE',
            lane === COORDINATOR
              ? `item #${id} is in the ${found.item_lane} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${id}`
              : `item #${id} is in the ${found.item_lane} lane; you are in ${lane}`,
          );
        },
        routeAllows: (found) => {
          const route = routeOf(board, agentId);
          return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${id} needs a ${found.item_route} model; you joined on the ${route} route. Take your next item: pullboard next`);
        },
        dependenciesVerified: (found) => {
          for (const dependency of found.item_after ? found.item_after.split(',').map(Number) : []) {
            const before = itemById(board, dependency);
            if (before.item_status !== 'verified') {
              return new Refused(
                'BLOCKED',
                `#${id} waits on #${dependency} (${current(board, before).item_status}, ${before.item_lane} lane); claim another item, or shout ${before.item_lane} if it is stuck`,
              );
            }
          }
          return null;
        },
        notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId ? new Refused('HELD', `item #${id} is held by ${found.item_owner} until ${found.item_lease_until}`) : null),
        laneOpen: (found) => {
          // Declared: not checked when the caller renews its own live claim.
          const paused = laneHold(board, found.item_lane);
          return paused && !isRenewal(found)
            ? new Refused('LANE_HELD', `${paused.hold_by} holds the ${found.item_lane} lane: ${paused.hold_reason}. Wait for it: pullboard next --wait 9 (minutes)`)
            : null;
        },
        itemNotHeld: (found) => {
          const held = itemHold(board, found.item_id);
          return held && !isRenewal(found)
            ? new Refused('ITEM_HELD', `item #${id} is held by coordinator: ${held.item_hold_reason}; wait for the coordinator to lift it with pullboard hold ${id} --off`)
            : null;
        },
        oneLiveClaim: (found) => {
          if (found.item_parent_id !== null || isRework(found)) return null;
          const other = board.db
            .prepare(
              `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
                 AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
                 AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
            )
            .get(agentId, now(board), id, agentId);
          return other ? new Refused('ONE_CLAIM', `you already hold #${other.item_id}; submit or release it first (child items are free)`) : null;
        },
        rowsInForce: (found) => {
          // Declared: checked only where the criterion freezes, so a renewal or a reclaim keeps its bar.
          if (found.item_frozen_digest !== null) return null;
          try {
            frozen = freeze(found);
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: (found) => ({
        ...(frozen ? { item_frozen: frozen.text, item_frozen_digest: frozen.digest } : {}),
        ...(!isRenewal(found) && head ? { item_claim_head: head } : {}),
        item_owner: agentId,
        item_lease_until: leaseUntil,
      }),
    });
    const renewed = isRenewal(item);
    const digest = frozen ? frozen.digest : item.item_frozen_digest;
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest, ...(!renewed && reviewSkipped ? { reviewSkipped } : {}) });
    return { leaseUntil, digest, renewed };
  });
}

/**
 * Hand a claimed item back, or free the caller's live review reservation on a submitted item.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {string} [note] One-line reason required when releasing a submitted review.
 * @returns {boolean} Whether a review reservation was released rather than a claim.
 */
export function release(board, id, agentId, note = '') {
  return atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status === 'submitted') {
      if (reviewHolder(board, item) !== agentId) {
        throw new Refused('NOT_YOURS', `item #${id} review is not reserved by you; ask its current reviewer to release it, or take a free review with pullboard next --verify`);
      }
      const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
      const problem = currentEngine >= 5 ? reviewReleaseNoteProblem(board, id, agentId, note) : null;
      if (problem) throw problem;
      const reason = typeof note === 'string' ? note.trim() : '';
      setItem(board, id, { item_review_by: null, item_review_until: null });
      if (currentEngine >= 5) logEvent(board, agentId, 'release', id, { review: true, reason });
      else logEvent(board, agentId, 'release', id);
      return true;
    }
    moveItem(board, id, 'release', {
      checks: {
        joined: null,
        [IN_STATE]: () => new Refused('NOT_YOURS', `item #${id} is not claimed by you`),
        isHolder: (found) => (found.item_owner === agentId ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you`)),
        reviewReleaseExplained: null, // Claimed releases do not free a submitted review.
      },
      set: () => ({ item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'release', id);
    return false;
  });
}

/**
 * Submit your claimed item at a commit (V4, V6). The caller has already checked the tree is clean
 * and run the gate green at that commit.
 *
 * Work a verifier rejected comes back only at a new head, so "done again" can never be the same
 * code declared twice.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string, files?: string[], policyCommit?: string }} at - `files`: what the
 *   item's own commits changed since its claim; a rework adds to what the first attempt changed.
 */
export function submit(board, id, { agentId, commit, tree, files = [], policyCommit = null }) {
  atomic(board, () => {
    const notYours = () => new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    moveItem(board, id, 'submit', {
      checks: {
        joined: null,
        [IN_STATE]: notYours,
        isHolder: (found) => (found.item_owner === agentId ? null : notYours()),
        criterionUnchanged: null,
        treeClean: null,
        nothingUntracked: null,
        hasCommit: null,
        withinLane: null,
        trunkMergeClean: null,
        gateConfigured: null,
        gateGreen: null,
        treeStillDuringGate: null,
        childrenDone: () => {
          const { total } = board.db
            .prepare("SELECT COUNT(*) AS total FROM item WHERE item_parent_id = ? AND item_status IN ('open', 'claimed', 'submitted')")
            .get(id);
          return total ? new Refused('CHILDREN_OPEN', `item #${id} has ${total} unfinished child items`) : null;
        },
        headIsNew: () => {
          const wasRejected = board.db.prepare("SELECT 1 FROM verdict WHERE item_id = ? AND verdict_decision = 'REJECT' AND verdict_commit = ?").get(id, commit);
          return wasRejected ? new Refused('HEAD_NOT_NEW', `#${id} was rejected at ${commit.slice(0, 12)}; commit the rework first`) : null;
        },
      },
      set: (found) => ({
        item_built_by: agentId,
        item_builder_family: board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null,
        item_commit: commit,
        item_tree: tree,
        item_lease_until: null,
        item_review_by: null,
        item_review_until: null,
        item_files: [...new Set([...(found.item_files ?? '').split('\n').filter(Boolean), ...files])].join('\n'),
      }),
    });
    logEvent(board, agentId, 'submit', id, { commit, tree, ...(policyCommit ? { policyCommit } : {}) });
  });
}

/**
 * Who holds an item's review under a live lease (V15), or null. A reservation counts only while the
 * item is submitted and its lease has not run out, and a new submission starts with none.
 *
 * @param {any} board
 * @param {any} item
 * @returns {string | null}
 */
export function reviewHolder(board, item) {
  return item.item_status === 'submitted' && item.item_review_by && (item.item_review_until ?? '') > now(board) ? item.item_review_by : null;
}

/** Validate a newly constructed review release while keeping old sealed replay executable [V1,R1,H16].
 * @param {any} board
 * @param {number} itemId
 * @param {string} agentId
 * @param {unknown} note
 * @returns {Refused | null}
 */
export function reviewReleaseNoteProblem(board, itemId, agentId, note) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 5) return null;
  let item;
  try { item = getItem(board, itemId); }
  catch (error) {
    // Missing items keep their native, ordered refusal; this preflight only validates review notes.
    if (error instanceof Refused && error.code === 'NO_ITEM') return null;
    throw error;
  }
  if (item.item_status !== 'submitted' || reviewHolder(board, item) !== agentId) return null;
  const reason = typeof note === 'string' ? note.trim() : '';
  if (!reason || /[\r\n\u2028\u2029]/u.test(reason)) {
    return new Refused('NOTE_REQUIRED', 'give the review release a one-line reason with --note "..."');
  }
  return null;
}

/** Find review releases after the current submission, optionally for one reviewer [V1,R1].
 * Older releases are ignored because a new submission starts a fresh review.
 */
function reviewReleasesSinceSubmit(board, itemId, agentId = null) {
  const events = board.db.prepare("SELECT event_id, event_at, event_by, event_kind, event_detail FROM event WHERE item_id=? AND event_kind IN ('submit','release') ORDER BY event_id DESC")
    .all(itemId);
  const releases = [];
  for (const event of events) {
    if (event.event_kind === 'submit') return releases;
    if (event.event_by !== agentId && agentId !== null) continue;
    try {
      const detail = JSON.parse(event.event_detail);
      if (detail.review === true || detail.review === undefined) releases.push({ ...event, legacy: detail.review === undefined,
        reason: detail.reason ?? 'reason not recorded' });
    } catch { /* Ignore malformed legacy details rather than treating them as review releases. */ }
  }
  return releases;
}

/** Return a reviewer's active one-hour cooldown, if a later submission has not reset it [V1,R1]. */
function reviewReleaseCooldown(board, itemId, agentId) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 5) return null;
  const event = reviewReleasesSinceSubmit(board, itemId, agentId).find((release) => !release.legacy);
  if (!event) return null;
  const until = Date.parse(event.event_at) + REVIEW_RELEASE_COOLDOWN_MS;
  return until > board.clock.now().getTime() ? new Date(until).toISOString() : null;
}

/** Count unreserved submissions by whether they are awaiting a first reviewer or were released [R1]. */
export function reviewQueueBreakdown(board) {
  let awaitingFirstReview = 0;
  let releasedWithoutVerdict = 0;
  const releasedItems = [];
  for (const item of listItems(board).filter((entry) => entry.item_status === 'submitted' && !reviewHolder(board, entry))) {
    const releases = reviewReleasesSinceSubmit(board, item.item_id);
    if (releases.length) {
      releasedWithoutVerdict += 1;
      releasedItems.push({ item: item.item_id, releases: releases.length, reason: releases[0].reason });
    } else awaitingFirstReview += 1;
  }
  return { awaitingFirstReview, releasedWithoutVerdict, releasedItems };
}

/** Summarize outstanding reviews using live leases and the latest submission's age [Q1,V15]. */
export function reviewQueue(board) {
  const pending = listItems(board).filter((item) => item.item_status === 'submitted');
  const holders = pending.map((item) => reviewHolder(board, item)).filter(Boolean);
  const submissions = new Map(board.db.prepare("SELECT item_id, MAX(event_at) AS submitted_at FROM event WHERE event_kind='submit' GROUP BY item_id")
    .all().map((event) => [event.item_id, event.submitted_at]));
  const oldestSubmittedAt = pending.map((item) => submissions.get(item.item_id)).filter(Boolean).sort()[0] ?? null;
  return { pending: pending.length, reviewing: new Set(holders).size, reserved: holders.length, oldestSubmittedAt,
    ageMs: oldestSubmittedAt ? Math.max(0, board.clock.now().getTime() - Date.parse(oldestSubmittedAt)) : 0 };
}

/** Offer an eligible review at the queue ratio without claiming or reserving anything [Q1,V15]. */
export function reviewOffer(board, { agentId, lane, policy = 'any', familyPolicy = 'off', ratio = 3, runnable = false, routes = ROUTES }) {
  const queue = reviewQueue(board);
  if (queue.pending < ratio * Math.max(queue.reviewing, 1)) return null;
  const { item } = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, runnable, routes });
  return item ? { item, queue, ratio } : null;
}

/**
 * What a verifier must pass before it reviews an item, alike when it reserves the review and when
 * it gives its verdict: it did not build the item, its route covers the item's, the repo's verify
 * policy lets it, and no other agent holds the review (V15). A reservation that lapsed holds
 * nothing, so the agent that made it can still give its verdict unless another reserved it since.
 *
 * @param {any} board
 * @param {{ agentId: string, policy: string, familyPolicy?: string }} who
 * @returns {Record<string, (found: any) => Refused | null>}
 */
function reviewerChecks(board, { agentId, policy, familyPolicy = 'off' }) {
  const family = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null;
  return {
    notBuilder: (found) => (found.item_built_by === agentId ? new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must') : null),
    routeAllows: (found) => {
      const route = routeOf(board, agentId);
      return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${found.item_id} needs a ${found.item_route} verifier; you joined on the ${route} route`);
    },
    policyAllows: (found) =>
      policy === COORDINATOR && found.item_lane !== COORDINATOR && agentId !== COORDINATOR ? new Refused('COORDINATOR_VERIFIES', 'this repo has the coordinator verify lane work') : null,
    familyAllows: (found) => familyPolicy === 'require' && (!family || !found.item_builder_family || family === found.item_builder_family)
      ? new Refused('O2_FAMILY_MATCH', `#${found.item_id} needs a verifier from another declared family under verify.family require; ask the coordinator to assign one`)
      : null,
    reviewFree: (found) => {
      const holder = reviewHolder(board, found);
      return holder && holder !== agentId
        ? new Refused('REVIEW_HELD', `${holder} holds the review of #${found.item_id} until ${found.item_review_until}; take another: pullboard next --verify`)
        : null;
    },
  };
}

/**
 * Reserve an item's review for an agent under a lease (V15): until it runs out, another agent's
 * verdict on the item, or reservation of it, is refused. Reserving again renews the lease.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any} The item, reserved.
 */
export function reserveReview(board, id, who) {
  return atomic(board, () => reserveWithin(board, id, who));
}

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it in one
 * transaction, so no other verifier can take it between the look and the reservation.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[] }} who
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, { agentId, lane, leaseMs, policy, familyPolicy = 'off', runnable, routes }) {
  return atomic(board, () => {
    const { item, reasons } = nextFor(board, { agentId, lane, verify: true, familyPolicy, runnable, routes });
    return item ? { item: reserveWithin(board, item.item_id, { agentId, leaseMs, policy, familyPolicy }), reasons: [] } : { item: null, reasons };
  });
}

/**
 * The reserve move, inside a transaction the caller holds.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any}
 */
function reserveWithin(board, id, { agentId, leaseMs, policy, familyPolicy = 'off' }) {
  const until = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  moveItem(board, id, 'reserve', {
    checks: {
      coordinatorSaysAs: null,
      joined: null,
      roadmapReadable: null, // Selection reads it before this move; explicit ids need no roadmap.
      [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
      /** Enforce the cooldown after state validation and before reviewer eligibility [V1]. */
      reviewCooldownElapsed: () => {
        const cooldown = reviewReleaseCooldown(board, id, agentId);
        return cooldown ? new Refused('REVIEW_COOLDOWN', `you released the review of #${id}; try again after ${cooldown}, or let another reviewer take it`) : null;
      },
      ...reviewerChecks(board, { agentId, policy, familyPolicy }),
    },
    set: () => ({ item_review_by: agentId, item_review_until: until }),
  });
  logEvent(board, agentId, 'reserve', id, { until });
  return getItem(board, id);
}

/**
 * Record a verdict on a submitted item (V1, V3, V5, V6, V8): an accept verifies it, a reject
 * reopens it for rework.
 *
 * The verdict binds the submitted commit and the digest frozen at claim. If the criterion's text
 * has moved since, there is no verdict to give: the coordinator refreezes it and the work is
 * claimed again. The builder never verifies; under `verify: "coordinator"`, lane work is the
 * coordinator's to verify; an agent verifies items at its tier or below, and not while another
 * agent holds the review (V15). An accept means CRITERION_MET and says how it was proved; a reject
 * names one of the reject reasons and says what failed.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, decision: string, reason?: string, note?: string, head: string, digest: string, policy: string, familyPolicy?: string, check?: 'none' | 'green' }} verdict
 * @returns {{ decision: string, reason: string, check?: 'none' | 'green' }}
 */
export function verify(board, id, { agentId, decision, reason, note = '', head, digest, policy, familyPolicy = 'off', check }) {
  const verb = { ACCEPT: 'accept', REJECT: 'reject' }[decision];
  if (!verb) throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  const isAccept = verb === 'accept';
  const code = isAccept ? ACCEPT_REASON : reason;
  return atomic(board, () => {
    const item = moveItem(board, id, verb, {
      checks: {
        coordinatorSaysAs: null,
        joined: null,
        [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
        atSubmittedCommit: null,
        ...reviewerChecks(board, { agentId, policy, familyPolicy }),
        criterionUnchanged: (found) =>
          digest === found.item_frozen_digest
            ? null
            : new Refused('CRITERIA_CHANGED', `the criterion for #${id} changed after it was claimed; the coordinator runs: pullboard refreeze ${id}`),
        reasonIsMet: () => (reason && reason !== ACCEPT_REASON ? new Refused('BAD_REASON', `accept means ${ACCEPT_REASON}; a failed criterion is a reject`) : null),
        trunkMergeClean: null,
        itemCheckGreen: null,
        proofNoted: () =>
          note.trim()
            ? null
            : new Refused('PROOF_REQUIRED', 'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof'),
        reasonCoded: () => (reason && REJECT_REASONS.includes(reason) ? null : new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`)),
        noteGiven: () => (note.trim() ? null : new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."')),
      },
      before: (found) => {
        const family = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null;
        board.db
          .prepare(
            `INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
               verdict_commit, verdict_digest, verdict_head, verdict_verifier_family, verdict_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, agentId, decision, code, note.trim(), found.item_commit, digest, head, family, now(board));
      },
      set: (found) => ({ item_verdict: decision, item_verified_by: isAccept ? agentId : null, item_owner: isAccept ? found.item_owner : null }),
    });
    const detail = { reason: code, commit: item.item_commit };
    if (isAccept && check !== undefined) detail.check = check;
    logEvent(board, agentId, verb, id, detail);
    return { decision, reason: code, ...(isAccept && check !== undefined ? { check } : {}) };
  });
}

/**
 * Refuse unless the acting agent is the coordinator.
 *
 * @param {string} agentId
 * @param {string} what
 */
function coordinatorOnly(agentId, what) {
  const refusal = onlyCoordinator(agentId, what);
  if (refusal) throw refusal;
}

/**
 * Record the commit a verified item landed as on the main line, e.g. after a squash merge.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string }} merge
 */
export function merged(board, id, { agentId, commit }) {
  coordinatorOnly(agentId, 'records merges');
  atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status !== 'verified') {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    setItem(board, id, { item_merged_commit: commit });
    logEvent(board, agentId, 'merged', id, { commit });
  });
}

/**
 * Withdraw an item nobody should build: a duplicate, or no longer wanted.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string }} why
 */
export function withdraw(board, id, { agentId, reason }) {
  atomic(board, () => {
    moveItem(board, id, 'withdraw', {
      checks: {
        joined: null,
        coordinatorOnly: () => onlyCoordinator(agentId, 'withdraws items'),
        noteGiven: () => (reason.trim() ? null : new Refused('NOTE_REQUIRED', 'say why it is withdrawn')),
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
      },
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'withdraw', id, { reason: reason.trim() });
  });
}

/**
 * Freeze an item's criterion again after its spec rows changed, and reopen it, so the next claim
 * builds against the text a verdict will check (V3). Explicit and logged: the bar moves only in
 * the open.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, freeze: (item: any) => { text: string, digest: string } }} who
 * @returns {{ before: string | null, after: string }}
 */
export function refreeze(board, id, { agentId, freeze }) {
  return atomic(board, () => {
    let frozen = null;
    const item = moveItem(board, id, 'refreeze', {
      checks: {
        joined: null,
        coordinatorOnly: () => onlyCoordinator(agentId, 'refreezes a criterion'),
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
        rowsInForce: (found) => {
          try {
            frozen = freeze(found);
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: () => ({ item_frozen: frozen.text, item_frozen_digest: frozen.digest, item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'refreeze', id, { before: item.item_frozen_digest, after: frozen.digest });
    return { before: item.item_frozen_digest, after: frozen.digest };
  });
}

/**
 * Items, newest first, as a reader should see them. Closed items (verified, withdrawn) only when
 * asked.
 *
 * @param {any} board
 * @param {{ lane?: string, all?: boolean }} [filter]
 * @returns {any[]}
 */
export function listItems(board, { lane, all = false } = {}) {
  const rows = board.db
    .prepare('SELECT * FROM item WHERE (? IS NULL OR item_lane = ?) ORDER BY item_id DESC')
    .all(lane ?? null, lane ?? null);
  const items = rows.map((item) => current(board, item));
  return all ? items : items.filter((item) => !['verified', 'withdrawn'].includes(item.item_status));
}

/**
 * One item as a reader should see it.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function getItem(board, id) {
  const item = current(board, itemById(board, id));
  const baseline = itemCheckBaseline(board, item);
  return baseline ? { ...item, item_check_baseline: baseline } : item;
}

/**
 * Every verdict on an item, oldest first.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any[]}
 */
export function verdictsFor(board, id) {
  const verdicts = board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(id);
  const receipts = board.db.prepare("SELECT event_kind, event_detail FROM event WHERE item_id = ? AND event_kind IN ('accept', 'reject') ORDER BY event_id").all(id);
  return verdicts.map((verdict, index) => {
    let detail = {};
    try { detail = JSON.parse(receipts[index]?.event_detail ?? '{}'); } catch { /* Malformed legacy details remain unknown. */ }
    return { ...verdict, check: detail.check ?? 'unknown' };
  });
}

/**
 * Insert a shout within the caller's transaction.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, channel?: 'terminal' | 'view' }} message
 * @returns {number}
 */
function insertShout(board, { from, to, text, lanes, decision = false, answers = null, evidence = null, request = false, channel = 'terminal' }) {
  if (!text.trim()) throw new Refused('EMPTY_SHOUT', 'a shout needs text');
  if (to === from) throw new Refused('SELF_SHOUT', `a shout cannot be addressed to its sender ${from}; name another agent, a lane or all`);
  if (request && (from !== 'person' || to !== COORDINATOR || decision || answers !== null)) {
    throw new Refused('BAD_REQUEST', 'a request goes from the person to the coordinator; use the board requests endpoint with its text');
  }
  const ask = answers === null ? null : getShout(board, answers);
  const isAgent = board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(to);
  const requestReply = ask?.shout_request && to === ask.shout_from;
  if (to !== 'all' && to !== PERSON && !lanes.includes(to) && !isAgent && !requestReply) {
    throw new Refused('NO_READER', `nobody reads "${to}": name a lane, an agent or all`);
  }
  if (to === PERSON && decision && from !== COORDINATOR) {
    throw new Refused('B26_PERSON_DECISION', `only the coordinator can ask the person for a decision; ask your coordinator: pullboard shout coordinator "${text.trim()}" --decision`);
  }
  let outcome = '';
  if (ask?.shout_request) {
    if (from !== COORDINATOR || !requestReply) throw new Refused('COORDINATOR_ONLY', `only the coordinator answers request #${answers}; ask the coordinator to run pullboard answer ${answers} done or declined <reason>`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ? AND shout_request_outcome != ?').get(answers, '')) {
      throw new Refused('REQUEST_CLOSED', `request #${answers} was already answered; read pullboard inbox before answering another request`);
    }
    const reply = /^(done|declined)(?:\s+([\s\S]+))?$/.exec(text.trim());
    if (!reply || (reply[1] === 'declined' && !reply[2]?.trim())) {
      throw new Refused('REQUEST_OUTCOME', `answer request #${answers} with done or declined followed by a reason: pullboard answer ${answers} done or declined <reason>`);
    }
    outcome = reply[1];
  } else if (ask && !ask.shout_decision) {
    throw new Refused('NOT_A_DECISION', `shout #${answers} asked for no decision; reply with pullboard shout`);
  }
  if (evidence) checkEvidence(board, evidence);
  const personAnswer = from === PERSON && answers !== null && !decision;
  if (personAnswer && !['terminal', 'view'].includes(channel)) {
    throw new Refused('B26_PERSON_CHANNEL', 'record the person answer through the terminal or the view; run pullboard view');
  }
  const result = board.db
    .prepare(
      `INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_decision, shout_answers,
         shout_evidence_kind, shout_evidence_outcome, shout_evidence_item, shout_evidence_commit,
         shout_request, shout_request_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(from, to, text.trim(), now(board), decision ? 1 : 0, answers, evidence?.kind ?? null, evidence ? evidence.outcome.trim() : null, evidence?.item ?? null, evidence?.commit ?? null, request ? 1 : 0, outcome);
  const id = Number(result.lastInsertRowid);
  logEvent(board, from, answers === null ? 'shout' : decision ? 'pass' : 'answer', null, { shout: id, to, decision: Boolean(decision), request: Boolean(request), answers, ...(outcome ? { outcome } : {}), ...(personAnswer ? { channel } : {}) });
  return id;
}

/**
 * Shout to a lane, an agent, `all`, or the person (B7, B25, B26). The caller passes declared lanes.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[], decision?: boolean, answers?: number | null, evidence?: any, request?: boolean, channel?: 'terminal' | 'view' }} message
 * @returns {number}
 */
export function shout(board, message) {
  return atomic(board, () => insertShout(board, message));
}

/**
 * Pass an open coordinator decision to the person with the original question and note (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, note: string, lanes: string[] }} options
 * @returns {number}
 */
export function passDecision(board, id, { agentId, note, lanes }) {
  return atomic(board, () => {
    if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator can pass a decision up');
    const ask = getShout(board, id);
    if (!ask.shout_decision || ask.shout_to !== COORDINATOR) throw new Refused('NOT_COORDINATOR_DECISION', `shout #${id} is not a decision waiting for the coordinator`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    const text = `Passed up from ${ask.shout_from}: ${ask.shout_text}\nCoordinator note: ${String(note ?? '').trim()}`;
    if (!String(note ?? '').trim()) throw new Refused('EMPTY_NOTE', 'include a note with the reason for passing this decision');
    return insertShout(board, { from: COORDINATOR, to: PERSON, text, lanes, decision: true, answers: id });
  });
}

/**
 * Answer an open decision addressed to the caller, delivering passed-up answers to the asker (B27).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, text: string, lanes: string[], asPerson?: boolean, channel?: 'terminal' | 'view' }} options
 * @returns {number}
 */
export function answerDecision(board, id, { agentId, text, lanes, asPerson = false, channel = 'terminal' }) {
  return atomic(board, () => {
    const ask = getShout(board, id);
    if (ask.shout_request) {
      if (asPerson) throw new Refused('B26_PERSON_ANSWER', `requests are answered by the coordinator; run pullboard answer ${id} done or declined <reason>`);
      return insertShout(board, { from: agentId, to: ask.shout_from, text, lanes, answers: id });
    }
    if (!ask.shout_decision) throw new Refused('NOT_A_DECISION', `shout #${id} asked for no decision`);
    if (board.db.prepare('SELECT 1 FROM shout WHERE shout_answers = ?').get(id)) throw new Refused('ALREADY_ANSWERED', `shout #${id} already has an answer`);
    if (asPerson && agentId !== COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `only the main checkout can answer as the person; ask your coordinator: pullboard answer ${id} "<answer>"`);
    if (asPerson && ask.shout_to !== PERSON) throw new Refused('B26_PERSON_ANSWER', `person mode answers only decisions addressed to the person; the coordinator answers this one: pullboard answer ${id} "<answer>"`);
    if (!asPerson && ask.shout_to === PERSON && agentId === COORDINATOR) throw new Refused('B26_PERSON_ANSWER', `this decision is addressed to the person; answer from the main checkout: pullboard answer ${id} "<answer>" --as person`);
    const personAnswer = asPerson;
    const caller = personAnswer ? null : board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id = ?').get(agentId);
    const ownsDecision = ask.shout_to === agentId || ask.shout_to === caller?.agent_lane;
    if (!ownsDecision && !personAnswer) {
      const lane = caller?.agent_lane ? `your ${caller.agent_lane} lane` : 'a lane you do not belong to';
      throw new Refused('NOT_YOUR_DECISION', `shout #${id} is addressed to ${ask.shout_to}, not ${lane} (agent ${agentId})`);
    }
    const from = personAnswer ? PERSON : agentId;
    const answerId = insertShout(board, { from, to: ask.shout_from, text, lanes, answers: id, channel });
    if (personAnswer && ask.shout_answers !== null) {
      const original = getShout(board, ask.shout_answers);
      insertShout(board, { from: PERSON, to: original.shout_from, text: `Person answered #${id}: ${String(text).trim()}`, lanes, answers: original.shout_id, channel });
    }
    return answerId;
  });
}

/** The kinds of evidence a shout can carry (B22): what was tried, or what was measured. */
export const EVIDENCE_KINDS = ['attempt', 'receipt'];

/**
 * Refuse evidence that is not fields a reader can trust (B22): its kind, its outcome, an item on
 * the board, and a full commit SHA, which the CLI resolves in the repo before it gets here.
 *
 * @param {any} board
 * @param {{ kind: string, outcome: string, item: number, commit: string }} evidence
 */
function checkEvidence(board, { kind, outcome, item, commit }) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new Refused('BAD_EVIDENCE', `the evidence kind is attempt or receipt, not "${kind ?? ''}": --evidence receipt`);
  if (!String(outcome ?? '').trim()) throw new Refused('BAD_EVIDENCE', 'evidence names its outcome: --outcome measured');
  if (!Number.isInteger(item) || !board.db.prepare('SELECT 1 FROM item WHERE item_id = ?').get(item)) {
    throw new Refused('BAD_EVIDENCE', `evidence names an item on the board: --item <id> (saw ${item})`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Refused('BAD_EVIDENCE', `evidence names a commit by its full SHA (saw "${commit ?? ''}")`);
}

/**
 * One shout by its id.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any}
 */
export function getShout(board, id) {
  const found = board.db.prepare('SELECT * FROM shout WHERE shout_id = ?').get(id);
  if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
  return found;
}

/** Read every shout in creation order without marking it read, for addressed history and exports. */
export function allShouts(board) {
  return board.db.prepare('SELECT * FROM shout ORDER BY shout_id').all();
}

/** Read one shout with the current open or answered state of its decision, if it is one. */
export function shoutDetails(board, id) {
  const shout = getShout(board, id);
  const answer = shout.shout_decision
    ? board.db.prepare('SELECT * FROM shout WHERE shout_answers = ? ORDER BY shout_id LIMIT 1').get(id) ?? null
    : null;
  return { ...shout, decision_state: shout.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
}

/**
 * Shouts that asked for a decision nobody has answered yet, oldest first (B21). An optional
 * recipient limits the queue; an array matches any listed recipient. Without one this returns
 * every open decision for internal readers.
 *
 * @param {any} board
 * @param {string | string[]} [recipient]
 * @returns {any[]}
 */
export function openDecisions(board, recipient = null) {
  if (recipient === null) {
    return board.db
      .prepare('SELECT * FROM shout ask WHERE ask.shout_decision = 1 AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id) ORDER BY ask.shout_id')
      .all();
  }
  const recipients = [...new Set(Array.isArray(recipient) ? recipient : [recipient])];
  if (!recipients.length) return [];
  const marks = recipients.map(() => '?').join(', ');
  return board.db
    .prepare(`SELECT * FROM shout ask WHERE ask.shout_decision = 1 AND ask.shout_to IN (${marks}) AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id) ORDER BY ask.shout_id`)
    .all(...recipients);
}

/** Requests remain visible to the coordinator until a done or declined answer closes them (A2). */
export function openRequests(board) {
  return board.db.prepare(`SELECT * FROM shout ask WHERE ask.shout_request = 1
    AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id AND reply.shout_request_outcome IN ('done', 'declined'))
    ORDER BY ask.shout_id`).all();
}

/**
 * The SQL that picks an agent's unread shouts: to it, to its lane, or to all, from anyone else.
 */
const UNREAD_SQL = `FROM shout WHERE shout_id > ? AND shout_from != ? AND shout_to IN ('all', ?, ?)`;

/**
 * Unread shouts for an agent, oldest first, then marked read.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {any[]}
 */
export function inbox(board, agentId) {
  return atomic(board, () => {
    const agent = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId);
    if (!agent) throw new Refused('NO_AGENT', `no agent ${agentId}`);
    const shouts = board.db
      .prepare(`SELECT * ${UNREAD_SQL} ORDER BY shout_id`)
      .all(agent.agent_last_shout_id, agentId, agent.agent_lane, agentId);
    const last = shouts.at(-1)?.shout_id ?? agent.agent_last_shout_id;
    board.db.prepare('UPDATE agent SET agent_last_shout_id = ? WHERE agent_id = ?').run(last, agentId);
    if (agentId !== COORDINATOR) return shouts;
    const requests = openRequests(board);
    const ids = new Set(requests.map((shout) => shout.shout_id));
    return [...requests, ...shouts.filter((shout) => !ids.has(shout.shout_id))];
  });
}

/**
 * How many shouts an agent has not read, without marking them.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {number}
 */
export function unreadCount(board, agentId) {
  const agent = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId);
  if (!agent) return 0;
  const { total } = board.db
    .prepare(`SELECT COUNT(*) AS total ${UNREAD_SQL}`)
    .get(agent.agent_last_shout_id, agentId, agent.agent_lane, agentId);
  return total;
}

/**
 * The event log, oldest first, for one item or the whole board.
 *
 * @param {any} board
 * @param {{ itemId?: number }} [filter]
 * @returns {any[]}
 */
export function events(board, { itemId } = {}) {
  return board.db
    .prepare('SELECT * FROM event WHERE (? IS NULL OR item_id = ?) ORDER BY event_id')
    .all(itemId ?? null, itemId ?? null);
}

/** Fact labels distinguish observations from judgements reserved to an item's live holder [B29,B30]. */
export const FACT_KINDS = Object.freeze(['capture', 'measurement', 'note', 'diff', 'decision', 'rejection', 'supersession', 'root-cause']);
const FACT_JUDGEMENTS = new Set(['decision', 'rejection', 'supersession', 'root-cause']);

/** Validate a portable code binding without reading source on replicas that hold only board data [B32,H7]. */
export function factReference(ref) {
  if (ref === null || ref === undefined) return null;
  const parts = typeof ref === 'string' && /^([^\r\n\0]+):(\d+)(?:-(\d+))?@([0-9a-f]{40})$/iu.exec(ref);
  if (!parts) throw new Refused('BAD_FACT_REF', 'a fact reference needs path:line[-line]@full-sha with all 40 hexadecimal characters; use the full git commit id');
  const [, path, first, last, commit] = parts;
  const start = Number(first), end = Number(last ?? first);
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Refused('BAD_FACT_REF', 'a fact reference needs a relative repo path and a positive ascending line range; use path:line[-line]@full-sha');
  }
  return { path, start, end, commit: commit.toLowerCase() };
}

/** Give facts the same stamped identity on CLI, API, export and replica reads [B29,B31]. */
function factFromEvent(event) {
  const detail = JSON.parse(event.event_detail);
  return { id: detail.id, eventId: event.event_id, kind: detail.kind, text: detail.text,
    by: event.event_by, at: event.event_at, ref: detail.ref ?? null, supersedes: detail.supersedes ?? null };
}

/** Read every move and fact in append order, including superseded facts and full original text [B31,B32]. */
export function itemThread(board, id) {
  itemById(board, id);
  return events(board, { itemId: id }).map((event) => event.event_kind === 'fact'
    ? { type: 'fact', ...factFromEvent(event) }
    : { type: 'move', eventId: event.event_id, kind: event.event_kind, by: event.event_by,
      at: event.event_at, detail: JSON.parse(event.event_detail) });
}

/** Add threads to public item projections without changing their existing fields [A1,A2,B32]. */
export function projectItemThreads(board, state) {
  return { ...state, items: state.items.map((item) => ({ ...item, thread: itemThread(board, item.id) })) };
}

/** Append a typed fact atomically; a correction never edits the original event [B29,B30,B31,B32].
 * The internal factId is set from a sealed move's identity during replay, rather than replica-local sequence ids.
 */
export function appendFact(board, id, { agentId, kind, text, ref = null, supersedes = null, factId = randomUUID() }) {
  return atomic(board, () => {
    const item = current(board, itemById(board, id));
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) throw new Refused('NO_AGENT', `no registered agent ${agentId}; join a worktree before appending a fact`);
    if (!FACT_KINDS.includes(kind)) throw new Refused('BAD_FACT_KIND', `unknown fact kind ${String(kind)}; use ${FACT_KINDS.join(', ')}`);
    if (typeof text !== 'string' || !text.trim()) throw new Refused('EMPTY_FACT', 'a fact needs nonempty text; supply the observation or judgement');
    if ((FACT_JUDGEMENTS.has(kind) || supersedes !== null) && agentId !== COORDINATOR && (!isHeld(board, item) || item.item_owner !== agentId)) {
      throw new Refused('FACT_JUDGEMENT', `only the item's live holder${isHeld(board, item) ? ' (' + item.item_owner + ')' : ''} or the coordinator may append a judgement or supersede a fact; append an observation or ask the coordinator`);
    }
    if (typeof factId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(factId)) throw new Refused('BAD_FACT_ID', 'a fact identity is invalid; retry with the current Pullboard engine');
    if (board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'fact' AND json_extract(event_detail, '$.id') = ?").get(factId)) throw new Refused('BAD_FACT_ID', 'this fact identity is already recorded; retry the original sealed move instead of appending it again');
    if (supersedes !== null && (typeof supersedes !== 'string' || !itemThread(board, id).some((entry) => entry.type === 'fact' && entry.id === supersedes))) {
      throw new Refused('NO_FACT', `no fact ${String(supersedes)} on item #${id}; use a fact id from pullboard show ${id} --json`);
    }
    const binding = factReference(ref);
    logEvent(board, agentId, 'fact', id, { id: factId, kind, text, ref: binding, supersedes });
    return factFromEvent(board.lastEvent);
  });
}

/**
 * Rank items by the first unfinished milestone that contains them, leaving unlisted work last.
 * A finished milestone no longer holds back later releases.
 *
 * @param {any} board
 * @returns {(entry: any) => number}
 */
function milestonePriorities(board) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 8) return () => 0;
  const ordered = milestones(board);
  const items = new Map(listItems(board, { all: true }).map((entry) => [entry.item_id, entry]));
  const priorities = new Map();
  for (const [index, milestone] of ordered.entries()) {
    const unfinished = milestone.items.some((id) => typeof id !== 'number' || items.get(id)?.item_status !== 'verified');
    if (!unfinished) continue;
    for (const id of milestone.items) if (!priorities.has(id)) priorities.set(id, index);
  }
  return (entry) => priorities.get(entry.item_id) ?? ordered.length;
}

/**
 * The next item an agent can take (N2): for a builder, the oldest open item in its lane whose
 * dependencies are verified; for a verifier, the oldest submitted item it did not build. An agent
 * sees items at its tier and below, its own tier first, so lighter work waits for lighter models
 * while there is heavier work to do (B13). When nothing is free, the reasons say what everything
 * is waiting on.
 *
 * With `runnable`, only items that carry a check command, which an unattended runner needs; with
 * `routes`, only items on those routes, the ones a runner has an agent command for. With `warm`, the
 * files the agent worked in lately, an item that shares more of them comes first within its tier,
 * and `shared` names them (N20). A held lane offers nothing new (N22).
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, verify?: boolean, policy?: string, familyPolicy?: string, runnable?: boolean, routes?: string[], warm?: string[] }} who
 * @returns {{ item: any | null, reasons: string[], shared?: string[] }}
 */
export function nextFor(board, { agentId, lane, verify = false, policy = 'any', familyPolicy = 'off', runnable = false, routes = ROUTES, warm = [] }) {
  const route = routeOf(board, agentId);
  const tier = (entry) => ROUTES.indexOf(entry.item_route);
  const allItems = listItems(board).reverse();
  const items = allItems
    .filter((entry) => canTake(route, entry.item_route) && routes.includes(entry.item_route) && (!runnable || entry.item_check))
    .sort((first, second) => tier(second) - tier(first));
  const tiers = route === 'strong' ? '' : `${ROUTES.slice(0, ROUTES.indexOf(route) + 1).reverse().join(' or ')} `;
  const routed = `${tiers}${runnable ? 'runnable ' : ''}`;
  if (verify) {
    const family = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null;
    const hasDifferentFamily = (entry) => Boolean(family && entry.item_builder_family && family !== entry.item_builder_family);
    let reviewable = items.filter((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId);
    if (policy === COORDINATOR && agentId !== COORDINATOR) reviewable = reviewable.filter((entry) => entry.item_lane === COORDINATOR);
    if (familyPolicy === 'require') reviewable = reviewable.filter(hasDifferentFamily);
    if (familyPolicy === 'prefer') reviewable.sort((first, second) => Number(hasDifferentFamily(second)) - Number(hasDifferentFamily(first)));
    const candidates = reviewable.map((entry) => ({
      entry,
      holder: reviewHolder(board, entry),
      cooldown: reviewReleaseCooldown(board, entry.item_id, agentId),
    }));
    const heldByMe = candidates.find((candidate) => candidate.holder === agentId)?.entry;
    if (heldByMe) return { item: heldByMe, reasons: [] };
    const milestonePriority = milestonePriorities(board);
    candidates.sort((first, second) => milestonePriority(first.entry) - milestonePriority(second.entry));
    const item = candidates.find((candidate) => !candidate.holder && !candidate.cooldown)?.entry;
    if (item) return { item, reasons: [] };
    const held = candidates.filter((candidate) => candidate.holder && candidate.holder !== agentId)
      .map(({ entry, holder: reviewer }) => `${reviewer} holds the review of #${entry.item_id} until ${entry.item_review_until}`);
    const cooling = candidates.filter((candidate) => candidate.cooldown)
      .map(({ entry, cooldown }) => `you released the review of #${entry.item_id}; try again after ${cooldown}, or let another reviewer take it`);
    return { item: null, reasons: [`nothing ${routed}submitted that you did not build${held.length ? ' and no other agent is reviewing' : ''}`, ...held, ...cooling] };
  }
  const held = items.find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
  if (held) return { item: held, reasons: [] };
  const reasons = allItems.filter((entry) => entry.item_status === 'open' && entry.item_lane === lane && entry.item_hold_reason)
    .map((entry) => `#${entry.item_id} is held by coordinator: ${entry.item_hold_reason}`);
  const paused = laneHold(board, lane);
  if (paused) return { item: null, reasons: [`${paused.hold_by} holds the ${lane} lane: ${paused.hold_reason}`, ...reasons] };
  const milestonePriority = milestonePriorities(board);
  const recent = new Set(warm);
  const laneItems = items.filter((entry) => entry.item_status === 'open' && entry.item_lane === lane);
  const mine = laneItems
    .filter((entry) => !itemHold(board, entry.item_id))
    .map((entry, order) => ({ entry, order, shared: itemFiles(entry).filter((path) => recent.has(path)) }))
    .sort((first, second) => milestonePriority(first.entry) - milestonePriority(second.entry)
      || tier(second.entry) - tier(first.entry) || second.shared.length - first.shared.length || first.order - second.order);
  for (const { entry, shared } of mine) {
    const waiting = (entry.item_after ? entry.item_after.split(',').map(Number) : [])
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified');
    if (!waiting.length) return { item: entry, reasons, shared };
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  if (!mine.length && !reasons.length) reasons.push(idleReason(items, lane, routed));
  // Nothing to claim, yet work above the agent's tier is open: name it and the ways through (B16).
  for (const entry of listItems(board).filter((open) => open.item_status === 'open' && open.item_lane === lane && !open.item_hold_reason && !canTake(route, open.item_route))) {
    reasons.push(`#${entry.item_id} (${entry.item_route}) is open in the ${lane} lane, above your ${route} route: a ${entry.item_route} agent takes it, or, if ${route} can build it, the coordinator reroutes it: pullboard edit ${entry.item_id} --route ${route}`);
  }
  return { item: null, reasons };
}

/**
 * An item something waits on, as the waiting agent needs it: its state, whether a verifier sent it
 * back, and the lane to shout.
 *
 * @param {any} item
 * @returns {string}
 */
function waitingOn(item) {
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ', rejected' : '';
  return `#${item.item_id} (${item.item_status}${rejected}, ${item.item_lane} lane)`;
}

/**
 * Why a lane has nothing to claim (N13): a lane whose items still await verdicts is not done, since
 * a rejected item comes back to it; the coordinator builds only its own lane's items.
 *
 * @param {any[]} items - Items not yet verified or withdrawn, as the agent may see them.
 * @param {string} lane
 * @param {string} routed
 * @returns {string}
 */
function idleReason(items, lane, routed) {
  const reason = `no open ${routed}items in the ${lane} lane`;
  if (lane === COORDINATOR) return `${reason}; lane items are built from each lane's own worktree`;
  const awaiting = items.filter((entry) => entry.item_lane === lane && entry.item_status === 'submitted').map((entry) => `#${entry.item_id}`);
  if (!awaiting.length) return reason;
  return `${reason}; ${awaiting.join(', ')} still await${awaiting.length === 1 ? 's' : ''} a verdict, and a rejected item comes back to this lane. A lane is done when its items are verified`;
}

/**
 * The files an item touches, as far as the board knows: the files its submission changed, else the
 * files its brief names.
 *
 * @param {any} item
 * @returns {string[]}
 */
export function itemFiles(item) {
  const changed = (item.item_files ?? '').split('\n').filter(Boolean);
  return [...new Set([...changed, ...briefFiles(item.item_brief ?? '')])];
}

/**
 * Finished items that touched the same files as this one, most shared first (N21). A builder
 * starting cold reads how its neighbours were done instead of rediscovering it. File overlap, not
 * word similarity: in one real build, an item shared a source file with one of the three before it
 * in its lane 56% of the time.
 *
 * @param {any} board
 * @param {any} item
 * @param {number} [limit]
 * @returns {{ item: any, shared: string[] }[]}
 */
export function relatedItems(board, item, limit = 3) {
  const mine = new Set(itemFiles(item));
  if (!mine.size) return [];
  return listItems(board, { all: true })
    .filter((other) => other.item_id !== item.item_id && other.item_status === 'verified')
    .map((other) => ({ item: other, shared: itemFiles(other).filter((path) => mine.has(path)) }))
    .filter((entry) => entry.shared.length)
    .sort((first, second) => second.shared.length - first.shared.length || second.item.item_id - first.item.item_id)
    .slice(0, limit);
}

/**
 * Hold a lane (N22): `next` there claims nothing and names the reason, so a pause lives on the board
 * and not in a message. Work already claimed goes on. Only the coordinator holds and releases.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, reason: string, asPerson?: boolean, channel?: string }} hold
 */
export function holdLane(board, lane, { agentId, reason, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'holds a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person hold through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  if (!String(reason ?? '').trim()) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${lane} --reason "why"`);
  atomic(board, () => {
    board.db
      .prepare(
        `INSERT INTO hold (hold_lane, hold_reason, hold_by, hold_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (hold_lane) DO UPDATE SET hold_reason = excluded.hold_reason, hold_by = excluded.hold_by, hold_at = excluded.hold_at`,
      )
      .run(lane, reason.trim(), by, now(board));
    logEvent(board, by, 'hold', null, { lane, reason: reason.trim(), ...(asPerson ? { channel } : {}) });
  });
}

/**
 * Release a held lane.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string, asPerson?: boolean, channel?: string }} who
 */
export function releaseLane(board, lane, { agentId, asPerson = false, channel = 'terminal' }) {
  coordinatorOnly(agentId, 'releases a lane');
  if (asPerson && !['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'record the person release through the terminal or the view; run pullboard view');
  const by = asPerson ? PERSON : agentId;
  atomic(board, () => {
    const { changes } = board.db.prepare('DELETE FROM hold WHERE hold_lane = ?').run(lane);
    if (!changes) throw new Refused('NOT_HELD', `the ${lane} lane is not held`);
    logEvent(board, by, 'unhold', null, { lane, ...(asPerson ? { channel } : {}) });
  });
}

/**
 * The hold on a lane, or null.
 *
 * @param {any} board
 * @param {string} lane
 * @returns {any | null}
 */
export function laneHold(board, lane) {
  return board.db.prepare('SELECT * FROM hold WHERE hold_lane = ?').get(lane) ?? null;
}

/**
 * Every held lane.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function laneHolds(board) {
  return board.db.prepare('SELECT * FROM hold ORDER BY hold_lane').all();
}

/** Read an item's coordinator hold, or null when it is available for claims. */
export function itemHold(board, id) {
  const item = getItem(board, id);
  return item.item_hold_reason ? {
    item_id: item.item_id, item_hold_reason: item.item_hold_reason,
    item_hold_by: item.item_hold_by, item_hold_at: item.item_hold_at,
  } : null;
}

/** Hold an open or already-claimed item without changing its current lifecycle state. */
export function holdItem(board, id, { agentId, reason }) {
  coordinatorOnly(agentId, 'holds an item');
  const text = String(reason ?? '').trim();
  if (!text) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${id} "why"`);
  return atomic(board, () => {
    const item = getItem(board, id);
    if (!['open', 'claimed'].includes(item.item_status)) {
      throw new Refused('ITEM_NOT_OPEN', `item #${id} is ${item.item_status}; only open or claimed items can be held`);
    }
    const at = now(board);
    setItem(board, id, { item_hold_reason: text, item_hold_by: agentId, item_hold_at: at });
    logEvent(board, agentId, 'hold_item', id, { reason: text });
    return itemHold(board, id);
  });
}

/** Lift an item's coordinator hold without changing any other item state. */
export function releaseItemHold(board, id, { agentId }) {
  coordinatorOnly(agentId, 'lifts an item hold');
  return atomic(board, () => {
    const held = itemHold(board, id);
    if (!held) throw new Refused('NOT_HELD', `item #${id} is not held`);
    setItem(board, id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null });
    logEvent(board, agentId, 'unhold_item', id, { reason: held.item_hold_reason });
  });
}

/** Read named milestones from board metadata; older boards simply have none. */
export function milestones(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('milestones');
  if (!row) return [];
  try {
    const value = JSON.parse(row.meta_value);
    if (!Array.isArray(value)) throw new Error('not an array');
    return value;
  } catch {
    throw new Refused('MILESTONES_CORRUPT', 'the stored roadmap is unreadable; restore board metadata from a known-good board export');
  }
}

/** Return milestones with current item status and a verified-item completion count. */
export function roadmap(board, resolveExternal = null) {
  const items = new Map(listItems(board, { all: true }).map((item) => [item.item_id, item]));
  return milestones(board).map((milestone) => {
    const entries = milestone.items.map((id) => {
      if (typeof id === 'number') {
        const item = items.get(id);
        return item
          ? { id, title: item.item_title, status: item.item_status }
          : { id, title: `#${id}`, status: 'missing' };
      }
      return resolveExternal?.(id) ?? { id, title: id, status: 'unavailable' };
    });
    return {
      name: milestone.name,
      note: milestone.note,
      items: entries,
      done: entries.filter((item) => item.status === 'verified').length,
      total: entries.length,
    };
  });
}

/** Validate a coordinator identity before changing roadmap metadata. */
function requireCoordinator(agentId) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator changes milestones; ask your coordinator to update the roadmap');
}

/** Parse an ordered list of local item ids and repo-qualified ids. */
function normalizeMilestoneItems(items) {
  if (!Array.isArray(items)) throw new Refused('MILESTONE_ITEMS', 'milestone items need comma-separated item ids; use pullboard milestone add --items 1,2');
  const result = items.map((value) => {
    if (Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
      if (/^[^#,\s][^#,]*#[1-9]\d*$/.test(text)) return text;
    }
    throw new Refused('MILESTONE_ITEMS', `invalid item id ${String(value)}; use a positive id or repo#id`);
  });
  if (new Set(result.map((value) => JSON.stringify(value))).size !== result.length) {
    throw new Refused('MILESTONE_ITEMS', 'a milestone cannot list the same item twice; remove duplicate ids and retry');
  }
  return result;
}

/** Refuse local item ids that do not exist while leaving repo-qualified ids for board lookup. */
function validateLocalMilestoneItems(board, items) {
  for (const id of items) if (typeof id === 'number') itemById(board, id);
}

/** Validate a milestone name and note before storing them. */
function normalizeMilestoneText(name, note = null) {
  if (typeof name !== 'string' || !name.trim()) throw new Refused('MILESTONE_NAME', 'a milestone needs a name; use pullboard milestone add <name>');
  if (typeof note !== 'string' && note !== null) throw new Refused('MILESTONE_NOTE', 'a milestone note needs text; use --note <text>');
  return { name: name.trim(), note: note?.trim() || null };
}

/** Save the whole milestone list in one board_meta value. */
function saveMilestones(board, entries) {
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run('milestones', JSON.stringify(entries));
}

/** Add an ordered milestone without changing any referenced board items. */
export function addMilestone(board, { agentId, name, note = null, items = [] }) {
  requireCoordinator(agentId);
  const text = normalizeMilestoneText(name, note);
  const normalized = normalizeMilestoneItems(items);
  validateLocalMilestoneItems(board, normalized);
  return atomic(board, () => {
    const entries = milestones(board);
    if (entries.some((entry) => entry.name === text.name)) throw new Refused('MILESTONE_EXISTS', `milestone ${text.name} already exists; edit it or choose another name`);
    saveMilestones(board, [...entries, { ...text, items: normalized }]);
    logEvent(board, agentId, 'milestone_add', null, { name: text.name, items: normalized });
    return text.name;
  });
}

/** Add or remove item references while preserving the remaining order. */
export function editMilestoneItems(board, name, { agentId, add = [], remove = [] }) {
  requireCoordinator(agentId);
  const additions = normalizeMilestoneItems(add);
  const removals = normalizeMilestoneItems(remove);
  validateLocalMilestoneItems(board, additions);
  if (additions.length && removals.length) throw new Refused('MILESTONE_ITEMS', 'add or remove milestone items in separate commands');
  if (!additions.length && !removals.length) throw new Refused('MILESTONE_ITEMS', 'name ids with --add or --remove');
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const current = entries[index];
    const nextItems = additions.length
      ? [...current.items, ...additions]
      : current.items.filter((id) => !removals.some((removeId) => JSON.stringify(removeId) === JSON.stringify(id)));
    if (additions.length && new Set(nextItems.map((value) => JSON.stringify(value))).size !== nextItems.length) {
      throw new Refused('MILESTONE_ITEMS', 'a milestone cannot list the same item twice; remove duplicate ids and retry');
    }
    if (removals.some((id) => current.items.every((present) => JSON.stringify(id) !== JSON.stringify(present)))) {
      throw new Refused('MILESTONE_ITEMS', 'one or more ids are not in this milestone; read pullboard roadmap and retry');
    }
    entries[index] = { ...current, items: nextItems };
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_items', null, { name, add: additions, remove: removals });
    return nextItems;
  });
}

/** Move a milestone before another while retaining all item and note data. */
export function moveMilestone(board, name, { agentId, before }) {
  requireCoordinator(agentId);
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    const target = entries.findIndex((entry) => entry.name === before);
    if (index < 0 || target < 0) throw new Refused('NO_MILESTONE', `name both milestones in pullboard milestone move ${name} --before <other>`);
    if (name === before) throw new Refused('MILESTONE_ORDER', 'choose a different milestone to move before');
    const [entry] = entries.splice(index, 1);
    entries.splice(entries.findIndex((value) => value.name === before), 0, entry);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_move', null, { name, before });
    return entries;
  });
}

/** Rename a milestone or update its note without touching its items. */
export function editMilestone(board, name, { agentId, newName, note }) {
  requireCoordinator(agentId);
  if (newName === undefined && note === undefined) throw new Refused('MILESTONE_EDIT', 'supply --name or --note to edit a milestone');
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const renamed = newName === undefined ? name : normalizeMilestoneText(newName).name;
    if (renamed !== name && entries.some((entry) => entry.name === renamed)) throw new Refused('MILESTONE_EXISTS', `milestone ${renamed} already exists; choose another name`);
    entries[index] = { ...entries[index], name: renamed, ...(note === undefined ? {} : { note: normalizeMilestoneText(renamed, note).note }) };
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_edit', null, { before: name, after: renamed, noteChanged: note !== undefined });
    return entries[index];
  });
}

/** Remove one milestone only; its referenced work items remain on their boards. */
export function removeMilestone(board, name, { agentId }) {
  requireCoordinator(agentId);
  return atomic(board, () => {
    const entries = milestones(board);
    const remaining = entries.filter((entry) => entry.name !== name);
    if (remaining.length === entries.length) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    saveMilestones(board, remaining);
    logEvent(board, agentId, 'milestone_remove', null, { name });
    return name;
  });
}

/** Current person decisions, including applied receipts, stored without checkout-dependent state. */
export function rowDecisions(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('row_decisions');
  return row ? JSON.parse(row.meta_value) : [];
}

/** Persist the current decision index inside its caller's board transaction. */
function writeRowDecisions(board, records) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('row_decisions', JSON.stringify(records));
}

/** Record one exact-row decision per event; sender-side channel checks precede deterministic replay. */
export function recordRowDecisions(board, { agentId, channel, decisions }) {
  if (agentId !== PERSON) throw new Refused('B26_PERSON_APPROVAL', 'only the person approves or declines rows; use pullboard view for the person to decide');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'row decisions use the terminal or the view; use pullboard view');
  if (!Array.isArray(decisions) || !decisions.length) throw new Refused('ROW_DECISION', 'name at least one row to approve or decline; use pullboard spec approve <ids>');
  const keys = new Set();
  for (const record of decisions) {
    if (!record || !['approve', 'decline'].includes(record.decision) || !['spec', 'doctrine'].includes(record.kind)
      || !['id', 'file', 'source', 'replacement', 'text'].every((key) => typeof record[key] === 'string' && record[key].trim())
      || (record.decision === 'decline' && !String(record.reason ?? '').trim())) throw new Refused('ROW_DECISION', 'a row decision needs its id, file and exact text; use pullboard spec approve or decline');
    const original = parseSpec(`## Decision\n${record.source}\n`).rows;
    const replacement = parseSpec(`## Decision\n${record.replacement}\n`).rows;
    const target = replacement[0];
    if (original.length !== 1 || original[0].id !== record.id || replacement.length !== 1 || target.id !== record.id
      || target.status !== (record.decision === 'approve' ? 'approved' : 'wont') || target.text !== record.text
      || (record.decision === 'decline' && target.text !== record.reason)) throw new Refused('ROW_DECISION', 'the exact row must match its recorded approval or decline; use pullboard spec approve or decline');
    const key = `${record.kind}:${record.id}`;
    if (keys.has(key)) throw new Refused('ROW_DECISION', `${key} is named twice; use each row once`);
    keys.add(key);
  }
  return atomic(board, () => {
    let current = rowDecisions(board);
    const recorded = decisions.map((record) => {
      logEvent(board, PERSON, 'row_decision', null, { record, channel });
      const entry = { ...record, event: board.lastEvent.event_id, at: board.lastEvent.event_at, applied: false };
      current = [...current.filter((old) => old.kind !== record.kind || old.id !== record.id), entry];
      return entry;
    });
    writeRowDecisions(board, current);
    return recorded;
  });
}

/** A coordinator records which exact decisions its local file changes applied, with no replay writes. */
export function applyRowDecisions(board, { agentId, events }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator applies row decisions; ask your coordinator to run pullboard spec apply');
  if (!Array.isArray(events) || events.some((event) => !Number.isSafeInteger(event) || event < 1)) throw new Refused('ROW_DECISION', 'apply needs current decision event ids; use pullboard spec apply');
  return atomic(board, () => {
    const records = rowDecisions(board);
    const found = events.map((event) => records.find((record) => record.event === event));
    if (found.some((record) => !record)) throw new Refused('STALE_ROW_DECISION', 'a row decision was replaced; use pullboard spec apply with the current decisions');
    const applied = found.filter((record) => !record.applied);
    if (!applied.length) return [];
    const at = now(board);
    writeRowDecisions(board, records.map((record) => events.includes(record.event) ? { ...record, applied: true, appliedAt: at } : record));
    logEvent(board, agentId, 'row_apply', null, { events: applied.map((record) => record.event) });
    return applied.map((record) => ({ ...record, applied: true, appliedAt: at }));
  });
}

/**
 * The newest unread shouts, without marking them read: `resume` shows them, `inbox` reads them.
 *
 * @param {any} board
 * @param {string} agentId
 * @param {number} [limit]
 * @returns {any[]}
 */
export function peekShouts(board, agentId, limit = 2) {
  const agent = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(agentId);
  if (!agent) return [];
  return board.db
    .prepare(`SELECT * ${UNREAD_SQL} ORDER BY shout_id DESC LIMIT ?`)
    .all(agent.agent_last_shout_id, agentId, agent.agent_lane, agentId, limit)
    .reverse();
}

/**
 * The newest shouts on the board, newest first, read without marking anything read (N26).
 *
 * @param {any} board
 * @param {number} [limit]
 * @returns {any[]}
 */
export function recentShouts(board, limit = 40) {
  return board.db.prepare('SELECT * FROM shout ORDER BY shout_id DESC LIMIT ?').all(limit);
}

/**
 * Counts for the status line and the ledger's summary: items by status, verdicts by decision.
 *
 * @param {any} board
 * @returns {{ items: Record<string, number>, accepted: number, rejected: number }}
 */
export function stats(board) {
  const items = { open: 0, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 };
  for (const item of listItems(board, { all: true })) items[item.item_status] += 1;
  const verdicts = board.db
    .prepare('SELECT verdict_decision AS decision, COUNT(*) AS total FROM verdict GROUP BY verdict_decision')
    .all();
  const count = (decision) => verdicts.find((row) => row.decision === decision)?.total ?? 0;
  return { items, accepted: count('ACCEPT'), rejected: count('REJECT') };
}
