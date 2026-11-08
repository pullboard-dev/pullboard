/** Shared numeric usage summaries: raw native sessions never enter the board [N2]. */
import { COST_ENGINE } from '../../../../src/cost-engine.js';
import { ENGINE_VERSION } from '../../../../src/engine-metadata.js';
import { publicSharedSessions } from './cost-shared.js';
import { Refused } from '../../../kernel/index.js';
import { COUNTS } from './cost-read.js';
import { UNKNOWN_USAGE_REASONS } from './cost-read.js';
import { sumUsage } from './cost-read.js';
import { SPLIT_COUNTS } from './cost-read.js';
import { hasInputSplit } from './cost-read.js';
import { unknownInputSplit } from './cost-read.js';
import { COST_INPUT_SPLIT_ENGINE } from '../../../../src/cost-input-split-engine.js';

/** Only documented numeric summary fields can be sealed, stored or replayed. */
export function sanitizedUsage(rows, engine = ENGINE_VERSION) {
  if (hasInputSplit(rows) && engine < COST_INPUT_SPLIT_ENGINE) throw new Refused('ENGINE_VERSION', `input splits require engine ${COST_INPUT_SPLIT_ENGINE}; upgrade Pullboard`);
  if (!Array.isArray(rows) || rows.length > 100) throw new Refused('USAGE_RECORD', 'record at most 100 model summaries per seat and item');
  return rows.map((row) => {
    if (!row || typeof row.model !== 'string' || row.model.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.model) || Object.keys(row).some((key) => !['model', 'unknownReasons', ...COUNTS].includes(key))) throw new Refused('USAGE_RECORD', 'usage carries a model and numeric totals only; keep session records private');
    const split = hasInputSplit([row]);
    if (split && SPLIT_COUNTS.some(name => !Object.hasOwn(row, name))) throw new Refused('USAGE_RECORD', 'input splits carry fresh, cached read and cached write counts, with explicit null when unavailable');
    const value = { model: row.model };
    for (const name of COUNTS.filter(name => split || !SPLIT_COUNTS.includes(name))) {
      const number = row[name];
      const valid = number === null && ['inputTokens', 'outputTokens', ...SPLIT_COUNTS].includes(name) || typeof number === 'number' && Number.isFinite(number) && number >= 0 && Number.isSafeInteger(number);
      if (!valid) throw new Refused('USAGE_RECORD', `${name} is a nonnegative provider value, or explicit null when unknown`);
      value[name] = number;
    }
    for (const [name, known] of [['inputTokens', 'knownInputTokens'], ['outputTokens', 'knownOutputTokens']]) {
      if (value[name] !== null && value[name] !== value[known]) throw new Refused('USAGE_RECORD', 'a complete usage total must match its known subtotal');
    }
    const reasons = row.unknownReasons ?? [];
    if (!Array.isArray(reasons) || reasons.length > UNKNOWN_USAGE_REASONS.length || new Set(reasons).size !== reasons.length
      || reasons.some(reason => !UNKNOWN_USAGE_REASONS.includes(reason))
      || (value.inputTokens === null || value.outputTokens === null) && !reasons.length) throw new Refused('USAGE_RECORD', 'unknown native token usage must name its bounded attribution reason');
    value.unknownReasons = [...reasons];
    return value;
  });
}

/** Record a caller's cumulative summary idempotently; delayed earlier revisions cannot erase newer totals. */
export function recordUsage(board, { agentId, item, revision, records, observedAt, shared = false }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < COST_ENGINE) throw new Refused('ENGINE_VERSION', `usage recording requires engine ${COST_ENGINE}; upgrade Pullboard`);
  if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? LIMIT 1').get(agentId)) throw new Refused('NOT_JOINED', 'join this board before recording seat usage');
  if (!Number.isSafeInteger(item) || item < 1) throw new Refused('USAGE_RECORD', 'usage names a positive item id');
  board.nativePorts.getItem(board, item);
  if (typeof shared !== 'boolean' || !Number.isSafeInteger(observedAt) || observedAt < 0 || !Number.isSafeInteger(revision) || revision < 1 || !board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' LIMIT 1").get(item, agentId)) throw new Refused('USAGE_RECORD', 'record usage only for an item this seat claimed, with a positive revision');
  const rows = sanitizedUsage(records, board.executionEngineVersion ?? ENGINE_VERSION);
  const key = `cost:${item}:${agentId}`;
  return board.nativePorts.atomic(board, () => {
    const old = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    const previous = old && JSON.parse(old.meta_value);
    if (previous?.revision >= revision) {
      if (previous.revision === revision && (previous.shared !== shared || previous.observedAt !== observedAt || JSON.stringify(previous.records) !== JSON.stringify(rows))) throw new Refused('USAGE_CHANGED', 'this usage revision already names different totals; publish a new revision');
      return { duplicate: true };
    }
    const value = { agent: agentId, item, revision, observedAt, shared, records: rows };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, JSON.stringify(value));
    // A checkpoint is not a lifecycle move: it names its item in detail and stays out of item histories.
    board.nativePorts.logEvent(board, agentId, 'usage', null, { item, revision, observedAt, shared, records: rows, estimate: true });
    return { recorded: true };
  });
}

/** Read shared summaries, grouping the same immutable numeric records for every machine. */
export function costTotals(board, prices) {
  const sharedItems = new Set(board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key GLOB 'shared-item:*'").all().map((row) => Number(row.meta_key.slice('shared-item:'.length))));
  const records = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().flatMap((row) => {
    const value = JSON.parse(row.meta_value);
    const item = board.nativePorts.getItem(board, value.item);
    return value.records.map((record) => ({ ...record, ...(sharedItems.has(value.item) ? { ...unknownInputSplit(), inputTokens: null, outputTokens: null, unknownReasons: [...new Set([...(record.unknownReasons ?? []), 'shared-session'])] } : {}), item: value.item, agent: value.agent, lane: item.item_lane, shared: Boolean(value.shared) || sharedItems.has(value.item) }));
  });
  const sharedSessions = publicSharedSessions(board);
  const sharedModels = sharedSessions.flatMap((group) => group.records.map((row) => ({ ...row, wallMs: 0 })));
  /** Group numeric records without multiplying totals across models. */
  const grouped = (name, values) => [...new Set(values.map((row) => row[name]))].map((value) => ({ [name]: value, ...sumUsage(values.filter((row) => row[name] === value), prices) }));
  return { items: grouped('item', records), lanes: grouped('lane', records), models: grouped('model', [...records, ...sharedModels]),
    milestones: board.nativePorts.milestones(board).map((milestone) => ({ milestone: milestone.name, ...sumUsage(records.filter((row) => milestone.items.includes(row.item)), prices) })),
    seats: grouped('agent', records), sharedSessions };
}

/** Seed a moved seat's private accumulator from already shared totals instead of resetting its revisions. */
export function storedSeatUsage(board, agent) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().map((row) => {
    const value = JSON.parse(row.meta_value);
    return { agentId: value.agent, item: value.item, revision: value.revision, observedAt: value.observedAt, shared: value.shared ?? false, records: value.records };
  }).filter((value) => value.agentId === agent);
}
