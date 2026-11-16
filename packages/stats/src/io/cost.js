/** Shared numeric usage summaries: raw native sessions never enter the board [N2]. */
import { COORDINATOR_USAGE_ENGINE } from '../../../state/light.js';
import { COST_ENGINE } from '../../../state/light.js';
import { ENGINE_VERSION } from '../../../state/light.js';
import { publicSharedSessions } from './cost/shared.js';
import { Refused } from '../../../kernel/light.js';
import { usageDollars } from '../../../config/browser.js';
import { loadMachineSettings } from '../../../config/index.js';
import { COUNTS } from './cost/usage.js';
import { UNKNOWN_USAGE_REASONS } from './cost/usage.js';
import { sumUsage } from './cost/usage.js';
import { SPLIT_COUNTS } from './cost/usage.js';
import { hasInputSplit } from './cost/usage.js';
import { unknownInputSplit } from './cost/usage.js';
import { COST_INPUT_SPLIT_ENGINE } from '../../../state/light.js';

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

/** The one write of a usage summary into board_meta, shared by seat and coordinator records. */
function writeUsageMeta(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, JSON.stringify(value));
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
    writeUsageMeta(board, key, value);
    // A checkpoint is not a lifecycle move: it names its item in detail and stays out of item histories.
    board.nativePorts.logEvent(board, agentId, 'usage', null, { item, revision, observedAt, shared, records: rows, estimate: true });
    return { recorded: true };
  });
}

/**
 * Record a coordinator session's cumulative usage under board_meta `coordinator:<session id>` with no claimed item.
 * Why: the coordinator never claims an item, so item-keyed recordUsage cannot hold its tokens; repeating a payload is a no-op [C7].
 */
export function recordCoordinatorUsage(board, { agentId = 'coordinator', session, records, observedAt }) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(session)) throw new Refused('USAGE_RECORD', 'coordinator usage names its session id');
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Refused('USAGE_RECORD', 'coordinator usage carries a nonnegative observedAt');
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < COORDINATOR_USAGE_ENGINE) throw new Refused('ENGINE_VERSION', `coordinator usage requires engine ${COORDINATOR_USAGE_ENGINE}; upgrade Pullboard`);
  const rows = sanitizedUsage(records, engine);
  const key = `coordinator:${session}`;
  return board.nativePorts.atomic(board, () => {
    const old = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    const value = { agent: 'coordinator', session, observedAt, records: rows };
    if (old) {
      if (old.meta_value !== JSON.stringify(value)) throw new Refused('USAGE_CHANGED', 'this coordinator session already names different totals; use a new session id');
      return { duplicate: true };
    }
    writeUsageMeta(board, key, value);
    // The ordered move needs a native receipt like every other move, so peers replay it; item histories never show it.
    board.nativePorts.logEvent(board, agentId, 'coordinator-usage', null, { session, observedAt, records: rows, estimate: true });
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
  // The coordinator's recorded sessions (#9685) join the model totals and read as their own entry; none recorded is unknown, never zero [C7].
  const coordinatorRows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'coordinator:%'").all().map((row) => JSON.parse(row.meta_value));
  const coordinatorRecords = coordinatorRows.flatMap((value) => value.records);
  const coordinator = coordinatorRows.length ? { sessions: coordinatorRows.length, ...sumUsage(coordinatorRecords, prices) }
    : { sessions: 0, ...unknownInputSplit(), inputTokens: null, outputTokens: null, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, models: [], unknownReasons: ['not-recorded'], shared: false, estimate: true };
  /** Group numeric records without multiplying totals across models. */
  const grouped = (name, values) => [...new Set(values.map((row) => row[name]))].map((value) => ({ [name]: value, ...sumUsage(values.filter((row) => row[name] === value), prices) }));
  return { items: grouped('item', records), lanes: grouped('lane', records), models: grouped('model', [...records, ...sharedModels, ...coordinatorRecords]),
    milestones: board.nativePorts.milestones(board).map((milestone) => ({ milestone: milestone.name, ...sumUsage(records.filter((row) => milestone.items.includes(row.item)), prices) })),
    seats: grouped('agent', records), sharedSessions, coordinator };
}

/** Seed a moved seat's private accumulator from already shared totals instead of resetting its revisions. */
export function storedSeatUsage(board, agent) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().map((row) => {
    const value = JSON.parse(row.meta_value);
    return { agentId: value.agent, item: value.item, revision: value.revision, observedAt: value.observedAt, shared: value.shared ?? false, records: value.records };
  }).filter((value) => value.agentId === agent);
}

/**
 * This machine's budget state for `board` at `now`, or null when no budget is set or the settings cannot be read [N2].
 * Why: status, the view and the morning report read the budget through this one reader.
 */
export function machineBudgetState(board, now) {
  let settings;
  try { settings = loadMachineSettings(); } catch { return null; }
  return settings.budget ? budgetState(board, settings.costPrices, settings.budget, now) : null;
}

/** Share of a limit at which a budget starts to warn. */
const BUDGET_WARN_AT = 0.8;

/**
 * Read a board's spend against its budget as ok, warn from 80 percent, or stop at 100 percent of either limit [N2].
 * Dollars come from the usage records each seat last published: the daily limit counts records observed on the
 * UTC day of `now`, the total limit counts all of them. With no budget set the state is ok and carries no limit.
 *
 * @param {object} board an open board
 * @param {object} prices dollars per million tokens by model
 * @param {{dailyUsd?: number, totalUsd?: number}|undefined} budget the machine budget setting
 * @param {number} now epoch milliseconds that decide which records count as today
 * @returns {{state: 'ok'|'warn'|'stop', spend: number, limit: number|null, which: 'dailyUsd'|'totalUsd'|null}}
 */
export function budgetState(board, prices, budget, now) {
  const rows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'cost:%'").all().map(row => JSON.parse(row.meta_value));
  const day = new Date(now).toISOString().slice(0, 10);
  const dollars = values => usageDollars(values.flatMap(value => value.records.map(record => ({ ...record, shared: Boolean(value.shared) }))), prices).knownCostUSD ?? 0;
  const spend = { dailyUsd: dollars(rows.filter(value => new Date(value.observedAt).toISOString().slice(0, 10) === day)), totalUsd: dollars(rows) };
  const limits = ['dailyUsd', 'totalUsd'].filter(name => budget?.[name] !== undefined);
  if (!limits.length) return { state: 'ok', spend: spend.totalUsd, limit: null, which: null };
  // The limit nearest its ceiling decides the state.
  const which = limits.reduce((worst, name) => spend[name] / budget[name] > spend[worst] / budget[worst] ? name : worst);
  const ratio = spend[which] / budget[which];
  return { state: ratio >= 1 ? 'stop' : ratio >= BUDGET_WARN_AT ? 'warn' : 'ok', spend: spend[which], limit: budget[which], which };
}

/**
 * The refusal a new claim meets when the budget is at its stop line, or null when the claim may go ahead [N2].
 * Only new claims are asked: an item already claimed keeps submitting and releasing, so nothing stops mid-item.
 *
 * @param {{state: string, spend: number, limit: number|null, which: string|null}|null} state the result of budgetState, or null with no budget
 * @returns {Refused|null} BUDGET_STOP naming the spend, the limit and the next step, or null
 */
export function budgetClaimRefusal(state) {
  if (state?.state !== 'stop') return null;
  const step = state.which === 'dailyUsd' ? 'raise budget.dailyUsd in the machine settings file, or resume after the next UTC day begins'
    : 'raise budget.totalUsd in the machine settings file';
  return new Refused('BUDGET_STOP', `the board has spent ${dollarText(state.spend)} against its ${state.which} limit of ${dollarText(state.limit)}; ${step}`);
}

/** Dollars as the refusal prints them, two decimals. */
function dollarText(value) {
  return '$' + value.toFixed(2);
}
