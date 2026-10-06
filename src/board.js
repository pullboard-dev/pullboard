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
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';

export const ACCEPT_REASON = 'CRITERION_MET';

/**
 * Who can take an item (B11): `strong` needs a frontier model's judgment; `light` is work any model
 * can build from its brief. An agent's route is set when it joins.
 */
export const ROUTES = ['strong', 'light'];
const BRIEF_LIMIT = 8000;
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
    ['agent', 'agent_route', "TEXT NOT NULL DEFAULT 'strong'"],
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
 * worktree as the next agent in its lane (`web-1`, `web-2`, ...), on a route: strong, or light for
 * a model that takes only items routed light (B11). Registering again is a no-op.
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
    throw new Refused('BAD_ROUTE', `route "${route}" is strong (needs a frontier model) or light (any model can build it from the brief)`);
  }
}

/**
 * Refuse a brief that cannot do its job (B10): too long to read cold, or missing on an item routed
 * light, where the brief is all a light model has to go on.
 *
 * @param {string} brief
 * @param {string} route
 */
function checkBrief(brief, route) {
  if (brief.length > BRIEF_LIMIT) {
    throw new Refused('BRIEF_TOO_LONG', `the brief is ${brief.length} characters; keep it under ${BRIEF_LIMIT} and point to longer docs by path`);
  }
  if (route === 'light' && !brief.trim()) {
    throw new Refused('NO_BRIEF', 'an item routed light carries a brief: the files, the contract, the pattern to copy and the command that proves it (--brief or --brief-file)');
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
export function addItem(board, { by, lane, title, criterion = '', specIds = [], parentId = null, after = [], brief = '', route = 'strong' }) {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Refused('NO_TITLE', 'an item needs a title');
  checkRoute(route);
  checkBrief(brief.trim(), route);
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
           item_after, item_brief, item_route, item_created_by, item_created_at, item_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(parentId, lane, cleanTitle, criterion.trim(), specIds.join(','), after.join(','), brief.trim(), route, by, at, at);
    const id = Number(result.lastInsertRowid);
    logEvent(board, by, 'add', id, { lane, specIds, after, route });
    return id;
  });
}

/**
 * Change an item's brief or route (B10, B11): how to build it and who can, never what it must do;
 * the criterion moves only by refreeze. The coordinator or the agent that added it may edit, until
 * it is verified or withdrawn; the route only while nobody holds it.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, brief?: string, route?: string }} change
 */
export function editItem(board, id, { agentId, brief, route }) {
  if (brief === undefined && route === undefined) {
    throw new Refused('USAGE', 'say what changes: --brief "...", --brief-file <file> or --route strong|light');
  }
  atomic(board, () => {
    const item = current(board, itemById(board, id));
    if (agentId !== COORDINATOR && agentId !== item.item_created_by) {
      throw new Refused('NOT_YOURS', `only the coordinator or ${item.item_created_by}, who added #${id}, edits it; shout them instead`);
    }
    if (['verified', 'withdrawn'].includes(item.item_status)) {
      throw new Refused('CLOSED', `item #${id} is ${item.item_status}`);
    }
    const nextRoute = route ?? item.item_route;
    const nextBrief = brief === undefined ? item.item_brief : brief.trim();
    checkRoute(nextRoute);
    if (nextRoute !== item.item_route && item.item_status !== 'open') {
      throw new Refused('HELD', `item #${id} is ${item.item_status}; change its route only while it is open`);
    }
    checkBrief(nextBrief, nextRoute);
    setItem(board, id, { item_brief: nextBrief, item_route: nextRoute });
    logEvent(board, agentId, 'edit', id, {
      ...(nextBrief !== item.item_brief ? { brief: `${nextBrief.length} characters` } : {}),
      ...(nextRoute !== item.item_route ? { route: nextRoute } : {}),
    });
  });
}

/**
 * Claim an item, or renew your own claim (B4, B5, B12, V2).
 *
 * One live top-level claim per agent, so nobody hoards; child items are free, which is how
 * sub-agents share a lane. A lapsed claim can be taken. Every item is built in its own lane, the
 * coordinator's included, so no agent can build another lane's work from the main checkout. The
 * first claim freezes the criterion: `freeze` returns the text and digest the verdict will later be
 * held to.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string } }} who
 * @returns {{ leaseUntil: string, digest: string, renewed: boolean }}
 */
export function claim(board, id, { agentId, lane, leaseMs, freeze }) {
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
    if (item.item_route !== 'light' && routeOf(board, agentId) === 'light') {
      throw new Refused('ROUTE', `item #${id} needs a strong model; you joined on the light route. Take the next light item: pullboard next`);
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
    if (item.item_parent_id === null) {
      const other = board.db
        .prepare(
          `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
             AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL`,
        )
        .get(agentId, now(board), id);
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
    setItem(board, id, {
      ...fields,
      item_status: 'claimed',
      item_owner: agentId,
      item_lease_until: leaseUntil,
    });
    const renewed = isMine && isHeld(board, item);
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
 * @param {{ agentId: string, commit: string, tree: string }} at
 */
export function submit(board, id, { agentId, commit, tree }) {
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
    });
    logEvent(board, agentId, 'submit', id, { commit, tree });
  });
}

/**
 * Who may verify an item, as a refusal when `agentId` may not (V1).
 *
 * The builder never may. Under `verify: "coordinator"`, lane work is the coordinator's to verify,
 * and the coordinator's own work is any other agent's. A light agent verifies light items only.
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
  if (item.item_route !== 'light' && routeOf(board, agentId) === 'light') {
    throw new Refused('ROUTE', `item #${item.item_id} needs a strong verifier; you joined on the light route`);
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
 * dependencies are verified; for a verifier, the oldest submitted item it did not build. A light
 * agent sees only items routed light; a strong one takes strong items first, leaving light work for
 * light models while there is any (B11). When nothing is free, the reasons say what everything is
 * waiting on.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, verify?: boolean }} who
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function nextFor(board, { agentId, lane, verify = false }) {
  const isLight = routeOf(board, agentId) === 'light';
  const items = listItems(board).reverse().filter((entry) => !isLight || entry.item_route === 'light');
  const routed = isLight ? 'light ' : '';
  if (verify) {
    const item = items.find((entry) => entry.item_status === 'submitted' && entry.item_built_by !== agentId) ?? null;
    return { item, reasons: item ? [] : [`nothing ${routed}submitted that you did not build`] };
  }
  const held = items.find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
  if (held) return { item: held, reasons: [] };
  const open = items.filter((entry) => entry.item_status === 'open' && entry.item_lane === lane);
  const mine = [...open.filter((entry) => entry.item_route !== 'light'), ...open.filter((entry) => entry.item_route === 'light')];
  const reasons = [];
  for (const entry of mine) {
    const waiting = (entry.item_after ? entry.item_after.split(',').map(Number) : [])
      .map((id) => current(board, itemById(board, id)))
      .filter((before) => before.item_status !== 'verified');
    if (!waiting.length) return { item: entry, reasons: [] };
    reasons.push(`#${entry.item_id} waits on ${waiting.map(waitingOn).join(', ')}`);
  }
  if (!mine.length) reasons.push(idleReason(items, lane, routed));
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
