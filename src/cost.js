/** Shared numeric usage summaries: raw native sessions never enter the board [N2]. */
import { atomic } from './board-event-log.js';
import { getItem } from './board-query.js';
import { listAgents } from './board-query.js';
import { logEvent } from './board-event-log.js';
import { milestones } from './board-read-auxiliary.js';
import { COST_ENGINE } from './cost-engine.js';
import { ENGINE_VERSION } from './machine.js';
import { publicSharedSessions } from './cost-shared.js';
import { Refused } from './refused.js';
import { COUNTS } from './cost-read.js';
import { sumUsage } from './cost-read.js';

/** Only documented numeric summary fields can be sealed, stored or replayed. */
export function sanitizedUsage(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Refused('USAGE_RECORD', 'record at most 100 model summaries per seat and item');
  return rows.map((row) => {
    if (!row || typeof row.model !== 'string' || row.model.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.model) || Object.keys(row).some((key) => !['model', ...COUNTS].includes(key))) throw new Refused('USAGE_RECORD', 'usage carries a model and numeric totals only; keep session records private');
    const value = { model: row.model };
    for (const name of COUNTS) {
      const number = row[name];
      const valid = number === null && ['inputTokens', 'outputTokens', 'costUSD'].includes(name) || typeof number === 'number' && Number.isFinite(number) && number >= 0 && (name.includes('Cost') || name === 'costUSD' || Number.isSafeInteger(number));
      if (!valid) throw new Refused('USAGE_RECORD', `${name} is a nonnegative provider value, or explicit null when unknown`);
      value[name] = number;
    }
    for (const [name, known] of [['inputTokens', 'knownInputTokens'], ['outputTokens', 'knownOutputTokens'], ['costUSD', 'knownCostUSD']]) {
      if (value[name] !== null && value[name] !== value[known]) throw new Refused('USAGE_RECORD', 'a complete usage total must match its known subtotal');
    }
    return value;
  });
}

/** Record a caller's cumulative summary idempotently; delayed earlier revisions cannot erase newer totals. */
export function recordUsage(board, { agentId, item, revision, records, observedAt, shared = false }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < COST_ENGINE) throw new Refused('ENGINE_VERSION', `usage recording requires engine ${COST_ENGINE}; upgrade Pullboard`);
  if (!listAgents(board).some((agent) => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join this board before recording seat usage');
  if (!Number.isSafeInteger(item) || item < 1) throw new Refused('USAGE_RECORD', 'usage names a positive item id');
  getItem(board, item);
  if (typeof shared !== 'boolean' || !Number.isSafeInteger(observedAt) || observedAt < 0 || !Number.isSafeInteger(revision) || revision < 1 || !board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' LIMIT 1").get(item, agentId)) throw new Refused('USAGE_RECORD', 'record usage only for an item this seat claimed, with a positive revision');
  const rows = sanitizedUsage(records);
  const key = `cost:${item}:${agentId}`;
  return atomic(board, () => {
    const old = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    const previous = old && JSON.parse(old.meta_value);
    if (previous?.revision >= revision) {
      if (previous.revision === revision && (previous.shared !== shared || previous.observedAt !== observedAt || JSON.stringify(previous.records) !== JSON.stringify(rows))) throw new Refused('USAGE_CHANGED', 'this usage revision already names different totals; publish a new revision');
      return { duplicate: true };
    }
    const value = { agent: agentId, item, revision, observedAt, shared, records: rows };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, JSON.stringify(value));
    // A checkpoint is not a lifecycle move: it names its item in detail and stays out of item histories.
    logEvent(board, agentId, 'usage', null, { item, revision, observedAt, shared, records: rows, estimate: true });
    return { recorded: true };
  });
}

/** Read shared summaries, grouping the same immutable numeric records for every machine. */
export function costTotals(board) {
  const sharedItems = new Set(board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'shared-item:*'").all().map((row) => Number(row.meta_key.slice('shared-item:'.length))));
  const records = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().flatMap((row) => {
    const value = JSON.parse(row.meta_value);
    const item = getItem(board, value.item);
    return value.records.map((record) => ({ ...record, ...(sharedItems.has(value.item) ? { inputTokens: null, outputTokens: null, costUSD: null } : {}), item: value.item, agent: value.agent, lane: item.item_lane, shared: Boolean(value.shared) || sharedItems.has(value.item) }));
  });
  const sharedSessions = publicSharedSessions(board);
  const sharedModels = sharedSessions.flatMap((group) => group.records.map((row) => ({ ...row, wallMs: 0 })));
  /** Group numeric records without multiplying totals across models. */
  const grouped = (name, values) => [...new Set(values.map((row) => row[name]))].map((value) => ({ [name]: value, ...sumUsage(values.filter((row) => row[name] === value)) }));
  return { items: grouped('item', records), lanes: grouped('lane', records), models: grouped('model', [...records, ...sharedModels]),
    milestones: milestones(board).map((milestone) => ({ milestone: milestone.name, ...sumUsage(records.filter((row) => milestone.items.includes(row.item))) })),
    seats: grouped('agent', records), sharedSessions };
}

/** Seed a moved seat's private accumulator from already shared totals instead of resetting its revisions. */
export function storedSeatUsage(board, agent) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().map((row) => {
    const value = JSON.parse(row.meta_value);
    return { agentId: value.agent, item: value.item, revision: value.revision, observedAt: value.observedAt, shared: value.shared ?? false, records: value.records };
  }).filter((value) => value.agentId === agent);
}
