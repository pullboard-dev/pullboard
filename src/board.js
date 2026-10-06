/**
 * The board (B1–B7, V1–V8, R1, R2): items, claims, submissions, verdicts and shouts in one SQLite
 * file in the git common dir, so every worktree sees the same board and nothing is committed.
 *
 * Every move is one immediate transaction (B2), so two agents can never claim the same item, and
 * every move lands in an append-only event log (R2). The caller supplies what only git and the
 * spec know: the commit, the verifier's checkout, the frozen criterion.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { briefFiles, briefSections } from './brief.js';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';

export const ACCEPT_REASON = 'CRITERION_MET';

/**
 * Who can take an item (B13), as tiers in order of the model an item needs: `light` is work a small
 * or local model can build from its brief, `mid` needs a capable general model, and
 * `strong` needs a frontier model's judgment. An agent's route is set when it joins; it takes items
 * at its tier and below.
 */
export const ROUTES = ['light', 'mid', 'strong'];
const BRIEF_LIMIT = 8000;

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
  CREATE TABLE IF NOT EXISTS agent (
    agent_id TEXT PRIMARY KEY,
    agent_lane TEXT NOT NULL,
    agent_path TEXT NOT NULL UNIQUE,
    agent_last_shout_id INTEGER NOT NULL DEFAULT 0,
    agent_route TEXT NOT NULL DEFAULT 'strong',
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
    item_commit TEXT,
    item_tree TEXT,
    item_verdict TEXT,
    item_verified_by TEXT,
    item_merged_commit TEXT,
    item_withdrawn_reason TEXT,
    item_created_by TEXT NOT NULL,
    item_created_at TEXT NOT NULL,
    item_updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS item_lane_status ON item (item_lane, item_status);
  CREATE TABLE IF NOT EXISTS verdict (
    verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES item (item_id),
    verdict_by TEXT NOT NULL,
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
  db.exec('PRAGMA busy_timeout = 10000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return { db, clock };
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
    ['item', 'item_claim_head', 'TEXT'],
    ['item', 'item_files', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, column, type] of added) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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

/**
 * Run `work` in one immediate transaction: the write lock is taken before the first read, so two
 * agents can never both see an item as free (B2).
 *
 * @template T
 * @param {any} board
 * @param {() => T} work
 * @returns {T}
 */
export function atomic(board, work) {
  board.db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    board.db.exec('COMMIT');
    return result;
  } catch (error) {
    board.db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Append one move to the event log (R2).
 *
 * @param {any} board
 * @param {string} by
 * @param {string} kind
 * @param {number | null} itemId
 * @param {object} [detail]
 */
function logEvent(board, by, kind, itemId, detail = {}) {
  board.db
    .prepare(
      'INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)',
    )
    .run(now(board), by, kind, itemId, JSON.stringify(detail));
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
 * behind it, which decides the items it may take (B13). Registering again is a no-op.
 *
 * @param {any} board
 * @param {{ lane: string, path: string, route?: string }} who
 * @returns {string} The agent's id.
 */
export function register(board, { lane, path, route = 'strong' }) {
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
        'INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, lane, path, route, now(board));
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
 * @param {{ by: string, lane: string, title: string, criterion?: string, specIds?: string[], parentId?: number | null, after?: number[], brief?: string, route?: string }} item
 * @returns {number} The new item's id.
 */
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong', check = '' }) {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  checkRouted({ brief: brief.trim(), route, criterion, check });
  return atomic(board, () => {
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
    const at = now(board);
    const result = board.db
      .prepare(
        `INSERT INTO item (item_parent_id, item_lane, item_title, item_criterion, item_spec_ids,
           item_after, item_brief, item_route, item_check, item_created_by, item_created_at, item_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(parentId, lane, cleanTitle, criterion.trim(), specIds.join(','), after.join(','), brief.trim(), route, check.trim(), by, at, at);
    const id = Number(result.lastInsertRowid);
    logEvent(board, by, 'add', id, { lane, specIds, after, route });
    return id;
  });
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
export function editItem(board, id, { agentId, brief, route, criterion, check }) {
  if ([brief, route, criterion, check].every((value) => value === undefined)) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --brief-file <file>, --route light|mid|strong, --criterion "..." or --check "<command>"');
  }
  atomic(board, () => {
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
      item_check: check === undefined ? item.item_check : check.trim(),
    };
    checkRoute(next.item_route);
    const moved = ['item_route', 'item_criterion', 'item_check'].filter((key) => next[key] !== item[key]);
    if (moved.length && item.item_status !== 'open') {
      throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route, criterion or check only while it is open`);
    }
    checkRouted({ brief: next.item_brief, route: next.item_route, criterion: next.item_criterion, check: next.item_check });
    const unfreeze = next.item_criterion !== item.item_criterion || next.item_check !== item.item_check;
    setItem(board, id, { ...next, ...(unfreeze ? { item_frozen: null, item_frozen_digest: null } : {}) });
    logEvent(board, agentId, 'edit', id, {
      ...(next.item_brief !== item.item_brief ? { brief: `${next.item_brief.length} characters` } : {}),
      ...(next.item_route !== item.item_route ? { route: next.item_route } : {}),
      ...(next.item_criterion !== item.item_criterion ? { criterion: next.item_criterion } : {}),
      ...(next.item_check !== item.item_check ? { check: next.item_check } : {}),
      ...(unfreeze && item.item_frozen_digest ? { unfrozen: item.item_frozen_digest } : {}),
    });
  });
}

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
  if (!note.trim()) throw new Refused('NOTE_REQUIRED', 'say what was tried and how it failed: --note "..."');
  return atomic(board, () => {
    const item = current(board, itemById(board, id));
    const isHolder = item.item_status === 'claimed' && item.item_owner === agentId;
    if (!isHolder && agentId !== COORDINATOR) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator escalates it`);
    }
    if (!['open', 'claimed'].includes(item.item_status)) {
      throw new Refused('CLOSED', `item #${id} is ${item.item_status}; escalate open or claimed work only`);
    }
    const from = item.item_route;
    const to = ROUTES[Math.min(ROUTES.indexOf(from) + 1, ROUTES.length - 1)];
    setItem(board, id, { item_route: to, item_status: 'open', item_owner: null, item_lease_until: null });
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
 * @param {{ agentId: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string }, head?: string | null }} who
 * @returns {{ leaseUntil: string, digest: string, renewed: boolean }}
 */
export function claim(board, id, { agentId, lane, leaseMs, freeze, head = null }) {
  return atomic(board, () => {
    const item = itemById(board, id);
    if (['submitted', 'verified', 'withdrawn'].includes(item.item_status)) {
      throw new Refused('NOT_CLAIMABLE', `item #${id} is ${item.item_status}`);
    }
    if (item.item_lane !== lane) {
      throw new Refused(
        'WRONG_LANE',
        lane === COORDINATOR
          ? `item #${id} is in the ${item.item_lane} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${id}`
          : `item #${id} is in the ${item.item_lane} lane; you are in ${lane}`,
      );
    }
    const route = routeOf(board, agentId);
    if (!canTake(route, item.item_route)) {
      throw new Refused('ROUTE', `item #${id} needs a ${item.item_route} model; you joined on the ${route} route. Take your next item: pullboard next`);
    }
    for (const dependency of item.item_after ? item.item_after.split(',').map(Number) : []) {
      const before = itemById(board, dependency);
      if (before.item_status !== 'verified') {
        throw new Refused(
          'BLOCKED',
          `#${id} waits on #${dependency} (${current(board, before).item_status}, ${before.item_lane} lane); claim another item, or shout ${before.item_lane} if it is stuck`,
        );
      }
    }
    const isMine = item.item_owner === agentId;
    if (isHeld(board, item) && !isMine) {
      throw new Refused('HELD', `item #${id} is held by ${item.item_owner} until ${item.item_lease_until}`);
    }
    const paused = laneHold(board, item.item_lane);
    if (paused && !(isMine && isHeld(board, item))) {
      throw new Refused('LANE_HELD', `${paused.hold_by} holds the ${item.item_lane} lane: ${paused.hold_reason}. Wait for it: pullboard next --wait 9 (minutes)`);
    }
    // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
    // builder fixing what a verifier found need not drop its other work to do it.
    const isRework = (entry) => entry.item_verdict === 'REJECT' && entry.item_built_by === agentId;
    if (item.item_parent_id === null && !isRework(item)) {
      const other = board.db
        .prepare(
          `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
             AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
             AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
        )
        .get(agentId, now(board), id, agentId);
      if (other) {
        throw new Refused(
          'ONE_CLAIM',
          `you already hold #${other.item_id}; submit or release it first (child items are free)`,
        );
      }
    }
    const fields = {};
    let digest = item.item_frozen_digest;
    if (digest === null) {
      const frozen = freeze(item);
      digest = frozen.digest;
      Object.assign(fields, { item_frozen: frozen.text, item_frozen_digest: frozen.digest });
    }
    const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
    const renewed = isMine && isHeld(board, item);
    if (!renewed && head) fields.item_claim_head = head;
    setItem(board, id, {
      ...fields,
      item_status: 'claimed',
      item_owner: agentId,
      item_lease_until: leaseUntil,
    });
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest });
    return { leaseUntil, digest, renewed };
  });
}

/**
 * Hand a claimed item back, open for anyone in its lane.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 */
export function release(board, id, agentId) {
  atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_owner !== agentId || item.item_status !== 'claimed') {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you`);
    }
    setItem(board, id, { item_status: 'open', item_owner: null, item_lease_until: null });
    logEvent(board, agentId, 'release', id);
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
 * @param {{ agentId: string, commit: string, tree: string, files?: string[] }} at - `files`: what the
 *   item's own commits changed since its claim; a rework adds to what the first attempt changed.
 */
export function submit(board, id, { agentId, commit, tree, files = [] }) {
  atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== agentId) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    }
    const { total } = board.db
      .prepare(
        "SELECT COUNT(*) AS total FROM item WHERE item_parent_id = ? AND item_status IN ('open', 'claimed', 'submitted')",
      )
      .get(id);
    if (total) throw new Refused('CHILDREN_OPEN', `item #${id} has ${total} unfinished child items`);
    const wasRejected = board.db
      .prepare("SELECT 1 FROM verdict WHERE item_id = ? AND verdict_decision = 'REJECT' AND verdict_commit = ?")
      .get(id, commit);
    if (wasRejected) {
      throw new Refused('HEAD_NOT_NEW', `#${id} was rejected at ${commit.slice(0, 12)}; commit the rework first`);
    }
    setItem(board, id, {
      item_status: 'submitted',
      item_built_by: agentId,
      item_commit: commit,
      item_tree: tree,
      item_lease_until: null,
      item_files: [...new Set([...(item.item_files ?? '').split('\n').filter(Boolean), ...files])].join('\n'),
    });
    logEvent(board, agentId, 'submit', id, { commit, tree });
  });
}

/**
 * Who may verify an item, as a refusal when `agentId` may not (V1).
 *
 * The builder never may. Under `verify: "coordinator"`, lane work is the coordinator's to verify,
 * and the coordinator's own work is any other agent's. An agent verifies items at its tier or below.
 *
 * @param {any} board
 * @param {any} item
 * @param {string} agentId
 * @param {string} policy
 */
function checkVerifier(board, item, agentId, policy) {
  if (item.item_built_by === agentId) {
    throw new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must');
  }
  const route = routeOf(board, agentId);
  if (!canTake(route, item.item_route)) {
    throw new Refused('ROUTE', `item #${item.item_id} needs a ${item.item_route} verifier; you joined on the ${route} route`);
  }
  if (policy === COORDINATOR && item.item_lane !== COORDINATOR && agentId !== COORDINATOR) {
    throw new Refused('COORDINATOR_VERIFIES', 'this repo has the coordinator verify lane work');
  }
}

/**
 * The reason a verdict must carry (V5): ACCEPT only for a met criterion; REJECT names what failed
 * and leaves a note the builder can act on.
 *
 * @param {string} decision
 * @param {string | undefined} reason
 * @param {string} note
 * @returns {string}
 */
function verdictReason(decision, reason, note) {
  if (decision === 'ACCEPT') {
    if (reason && reason !== ACCEPT_REASON) {
      throw new Refused('BAD_REASON', `accept means ${ACCEPT_REASON}; a failed criterion is a reject`);
    }
    if (!note.trim()) {
      throw new Refused(
        'PROOF_REQUIRED',
        'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof',
      );
    }
    return ACCEPT_REASON;
  }
  if (decision !== 'REJECT') throw new Refused('BAD_DECISION', 'the decision is accept or reject');
  if (!reason || !REJECT_REASONS.includes(reason)) {
    throw new Refused('BAD_REASON', `a reject names one of: ${REJECT_REASONS.join(', ')}`);
  }
  if (!note.trim()) throw new Refused('NOTE_REQUIRED', 'a reject says what failed: --note "..."');
  return reason;
}

/**
 * Record a verdict on a submitted item (V1, V3, V5, V6, V8).
 *
 * The verdict binds the submitted commit and the digest frozen at claim. If the criterion's text
 * has moved since, there is no verdict to give: the coordinator refreezes it and the work is
 * claimed again. ACCEPT verifies the item; REJECT reopens it for rework.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, decision: string, reason?: string, note?: string, head: string, digest: string, policy: string }} verdict
 * @returns {{ decision: string, reason: string }}
 */
export function verify(board, id, { agentId, decision, reason, note = '', head, digest, policy }) {
  return atomic(board, () => {
    const item = itemById(board, id);
    if (item.item_status !== 'submitted') {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, item).item_status}, not submitted`);
    }
    checkVerifier(board, item, agentId, policy);
    if (digest !== item.item_frozen_digest) {
      throw new Refused(
        'CRITERIA_CHANGED',
        `the criterion for #${id} changed after it was claimed; the coordinator runs: pullboard refreeze ${id}`,
      );
    }
    const code = verdictReason(decision, reason, note);
    board.db
      .prepare(
        `INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
           verdict_commit, verdict_digest, verdict_head, verdict_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agentId, decision, code, note.trim(), item.item_commit, digest, head, now(board));
    const isAccept = decision === 'ACCEPT';
    setItem(board, id, {
      item_status: isAccept ? 'verified' : 'open',
      item_verdict: decision,
      item_verified_by: isAccept ? agentId : null,
      item_owner: isAccept ? item.item_owner : null,
    });
    logEvent(board, agentId, isAccept ? 'accept' : 'reject', id, {
      reason: code,
      commit: item.item_commit,
    });
    return { decision, reason: code };
  });
}

/**
 * Refuse unless the acting agent is the coordinator.
 *
 * @param {string} agentId
 * @param {string} what
 */
function coordinatorOnly(agentId, what) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', `only the coordinator ${what}`);
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
  coordinatorOnly(agentId, 'withdraws items');
  if (!reason.trim()) throw new Refused('NOTE_REQUIRED', 'say why it is withdrawn');
  atomic(board, () => {
    const item = itemById(board, id);
    if (['verified', 'withdrawn'].includes(item.item_status)) {
      throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
    }
    setItem(board, id, {
      item_status: 'withdrawn',
      item_withdrawn_reason: reason.trim(),
      item_owner: null,
      item_lease_until: null,
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
  coordinatorOnly(agentId, 'refreezes a criterion');
  return atomic(board, () => {
    const item = itemById(board, id);
    if (['verified', 'withdrawn'].includes(item.item_status)) {
      throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
    }
    const frozen = freeze(item);
    setItem(board, id, {
      item_frozen: frozen.text,
      item_frozen_digest: frozen.digest,
      item_status: 'open',
      item_owner: null,
      item_lease_until: null,
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
  return current(board, itemById(board, id));
}

/**
 * Every verdict on an item, oldest first.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any[]}
 */
export function verdictsFor(board, id) {
  return board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(id);
}

/**
 * Shout to a lane, an agent, or `all` (B7). The caller passes the lanes the config declares.
 *
 * @param {any} board
 * @param {{ from: string, to: string, text: string, lanes: string[] }} message
 */
export function shout(board, { from, to, text, lanes }) {
  if (!text.trim()) throw new Refused('EMPTY_SHOUT', 'a shout needs text');
  const isAgent = board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(to);
  if (to !== 'all' && !lanes.includes(to) && !isAgent) {
    throw new Refused('NO_READER', `nobody reads "${to}": name a lane, an agent or all`);
  }
  board.db
    .prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)')
    .run(from, to, text.trim(), now(board));
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
    return shouts;
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
 * @param {{ agentId: string, lane: string, verify?: boolean, runnable?: boolean, routes?: string[], warm?: string[] }} who
 * @returns {{ item: any | null, reasons: string[], shared?: string[] }}
 */
export function nextFor(board, { agentId, lane, verify = false, runnable = false, routes = ROUTES, warm = [] }) {
  const route = routeOf(board, agentId);
  const tier = (entry) => ROUTES.indexOf(entry.item_route);
  const items = listItems(board)
    .reverse()
    .filter((entry) => canTake(route, entry.item_route) && routes.includes(entry.item_route) && (!runnable || entry.item_check))
    .sort((first, second) => tier(second) - tier(first));
  const tiers = route === 'strong' ? '' : `${ROUTES.slice(0, ROUTES.indexOf(route) + 1).reverse().join(' or ')} `;
  const routed = `${tiers}${runnable ? 'runnable ' : ''}`;
  if (verify) {
    const item = items.find((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId) ?? null;
    return { item, reasons: item ? [] : [`nothing ${routed}submitted that you did not build`] };
  }
  const held = items.find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
  if (held) return { item: held, reasons: [] };
  const paused = laneHold(board, lane);
  if (paused) return { item: null, reasons: [`${paused.hold_by} holds the ${lane} lane: ${paused.hold_reason}`] };
  const recent = new Set(warm);
  const mine = items
    .filter((entry) => entry.item_status === 'open' && entry.item_lane === lane)
    .map((entry, order) => ({ entry, order, shared: itemFiles(entry).filter((path) => recent.has(path)) }))
    .sort((first, second) => tier(second.entry) - tier(first.entry) || second.shared.length - first.shared.length || first.order - second.order);
  const reasons = [];
  for (const { entry, shared } of mine) {
    const waiting = (entry.item_after ? entry.item_after.split(',').map(Number) : [])
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified');
    if (!waiting.length) return { item: entry, reasons: [], shared };
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  if (!mine.length) reasons.push(idleReason(items, lane, routed));
  // Nothing to claim, yet work above the agent's tier is open: name it and the ways through (B16).
  for (const entry of listItems(board).filter((open) => open.item_status === 'open' && open.item_lane === lane && !canTake(route, open.item_route))) {
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
 * @param {{ agentId: string, reason: string }} hold
 */
export function holdLane(board, lane, { agentId, reason }) {
  coordinatorOnly(agentId, 'holds a lane');
  if (!String(reason ?? '').trim()) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${lane} --reason "why"`);
  atomic(board, () => {
    board.db
      .prepare(
        `INSERT INTO hold (hold_lane, hold_reason, hold_by, hold_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (hold_lane) DO UPDATE SET hold_reason = excluded.hold_reason, hold_by = excluded.hold_by, hold_at = excluded.hold_at`,
      )
      .run(lane, reason.trim(), agentId, now(board));
    logEvent(board, agentId, 'hold', null, { lane, reason: reason.trim() });
  });
}

/**
 * Release a held lane.
 *
 * @param {any} board
 * @param {string} lane
 * @param {{ agentId: string }} who
 */
export function releaseLane(board, lane, { agentId }) {
  coordinatorOnly(agentId, 'releases a lane');
  atomic(board, () => {
    const { changes } = board.db.prepare('DELETE FROM hold WHERE hold_lane = ?').run(lane);
    if (!changes) throw new Refused('NOT_HELD', `the ${lane} lane is not held`);
    logEvent(board, agentId, 'unhold', null, { lane });
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
