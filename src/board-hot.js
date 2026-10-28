import { ensureFactIdentityIndexes } from './fact-identity.js';
import { missingFactIdentityIndexes } from './fact-identity.js';
import { ensureGrantActivationIndex } from '../packages/state/src/core/relay-activation.js';
import { missingGrantActivationIndex } from '../packages/state/src/core/relay-activation.js';

/**
 * The indexes and bounded reads behind the board's hot queries [C7]. Status, list, show, next, resume,
 * health and the view read events and shouts by kind, sender, answer and recency; on a board of tens of
 * thousands of rows each of those was a full scan (openDecisions 796 ms, health's agent activity 11 s).
 */

/** Each index a hot query needs; IF NOT EXISTS lets an existing board gain them on its next open. */
const HOT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS shout_answers ON shout (shout_answers)',
  'CREATE INDEX IF NOT EXISTS shout_open_decision ON shout (shout_decision, shout_to) WHERE shout_decision = 1',
  'CREATE INDEX IF NOT EXISTS shout_open_request ON shout (shout_request) WHERE shout_request = 1',
  'CREATE INDEX IF NOT EXISTS shout_evidence_item ON shout (shout_evidence_item) WHERE shout_evidence_item IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS shout_from_at ON shout (shout_from, shout_at)',
  'CREATE INDEX IF NOT EXISTS event_by_at ON event (event_by, event_at)',
  'CREATE INDEX IF NOT EXISTS event_kind_id ON event (event_kind, event_id)',
];

/**
 * Create the hot-query indexes. They index columns that migrate() adds to older boards, so this runs
 * after it, never inside the table schema.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureHotIndexes(db) {
  for (const sql of HOT_INDEXES) db.exec(sql);
  ensureAdditiveIndexes(db);
}

/** Detect the additive upgrades eligible for an owning, already-current board. */
export function missingAdditiveIndexes(db) {
  return missingFactIdentityIndexes(db).length > 0 || missingGrantActivationIndex(db);
}

/** Install only additive fact/activation upgrades, inside the opener's existing atomic restamp. */
export function ensureAdditiveIndexes(db) {
  ensureFactIdentityIndexes(db);
  ensureGrantActivationIndex(db);
}

/**
 * Events of the given kinds, oldest first, read through the kind index instead of the whole log.
 *
 * @param {any} board
 * @param {string[]} kinds
 * @returns {any[]}
 */
export function eventsOfKinds(board, kinds) {
  if (!kinds.length) return [];
  return board.db.prepare(`SELECT * FROM event WHERE event_kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY event_id`).all(...kinds);
}

/**
 * Read landing evidence and only the exact submissions a failed gate names. Proposals need no
 * unrelated submission history, and a board with no failed landing needs no submission rows.
 * Keep every landing snapshot in order: later green gates/diagnostics still clear earlier reds,
 * while repeated evidence keeps the original ordering rules in submitInvariantProposals.
 */
export function submitInvariantEvents(board, config) {
  if (config.submitGate !== 'landing') return [];
  const landings = eventsOfKinds(board, ['landing_batch']);
  const needed = new Map();
  for (const event of landings) {
    const detail = JSON.parse(event.event_detail);
    for (const gate of detail.batch?.invariantEvidence?.gates ?? []) {
      if (gate.isGreen || !gate.failures.length) continue;
      for (const row of gate.submissions) needed.set(`${row.id}:${row.commit}`, row);
    }
  }
  if (!needed.size) return [];
  const submissions = [];
  const history = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC");
  const remaining = new Map();
  for (const { id, commit } of needed.values()) {
    const commits = remaining.get(id) ?? new Set();
    commits.add(commit);
    remaining.set(id, commits);
  }
  for (const [id, commits] of remaining) {
    for (const event of history.iterate(id)) {
      const detail = JSON.parse(event.event_detail);
      if (!commits.has(detail.commit) || !detail.submissionProof) continue;
      submissions.push(event);
      commits.delete(detail.commit);
      if (!commits.size) break;
    }
  }
  return [...landings, ...submissions].sort((a, b) => a.event_id - b.event_id);
}

/**
 * The newest events, newest first. The id bound states the range read, so the plan seeks from the
 * end of the log rather than scanning it.
 *
 * @param {any} board
 * @param {number} limit
 * @returns {any[]}
 */
export function recentEvents(board, limit) {
  return board.db.prepare('SELECT * FROM event WHERE event_id > 0 ORDER BY event_id DESC LIMIT ?').all(limit);
}

/**
 * The newest shouts on the board, newest first, read without marking anything read (N26), seeking
 * from the end of the table the same way as recentEvents.
 *
 * @param {any} board
 * @param {number} [limit]
 * @returns {any[]}
 */
export function recentShouts(board, limit = 40) {
  return board.db.prepare('SELECT * FROM shout WHERE shout_id > 0 ORDER BY shout_id DESC LIMIT ?').all(limit);
}

/**
 * When each agent last moved on the board, one index seek per agent.
 *
 * @param {any} board
 * @returns {Map<string, string>}
 */
export function lastMoves(board) {
  const rows = board.db.prepare('SELECT agent_id, (SELECT MAX(event_at) FROM event WHERE event_by = agent.agent_id) AS at FROM agent').all();
  return new Map(rows.filter((row) => row.at).map((row) => [row.agent_id, row.at]));
}

/**
 * The shouts the coordinator's resume reads: every decision ask and every integration evidence shout,
 * oldest first, through their partial indexes rather than the whole shout table. A UNION, because
 * SQLite uses no partial index for one arm of an OR, and the order outside it, or SQLite scans for it.
 *
 * @param {any} board
 * @returns {any[]}
 */
export function decisionAndEvidenceShouts(board) {
  // Two indexed reads merged here: SQLite 3.53 (Node 24) plans the UNION of these as a full shout scan.
  const decisions = board.db.prepare('SELECT * FROM shout WHERE shout_decision = 1').all();
  const evidence = board.db.prepare('SELECT * FROM shout WHERE shout_evidence_item IS NOT NULL AND shout_evidence_item > 0').all();
  const byId = new Map([...decisions, ...evidence].map((row) => [row.shout_id, row]));
  return [...byId.values()].sort((a, b) => a.shout_id - b.shout_id);
}
