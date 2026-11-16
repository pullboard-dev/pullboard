import { normalizeRulingEffects } from "../../../../spec/light.js";
import { RULING_OWNER_ENGINE } from "../../../../state/light.js";
/** Structured choices on the existing append-only decision/answer stream [B21,B27]. */
import { DECISION_QUEUE_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/light.js";
import { shoutItemId } from "../../../../kernel/light.js";

/** Validate new decision metadata before any message is persisted, without changing legacy shouts. */
export function itemDecisionDetail(board, message, { itemShoutReader }, engine) {
  const { options, decision, item, from, effects } = message;
  const detail = {};
  if (effects !== undefined) {
    if (engine < RULING_OWNER_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before declaring ruling effects');
    if (!decision) throw new Refused('RULING_EFFECTS', 'declare effects on a decision request with --decision --effects');
    detail.decisionEffects = normalizeRulingEffects(effects);
  }
  if (options === undefined) return detail;
  if (engine < DECISION_QUEUE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before asking an item decision with options');
  if (!decision || !Number.isSafeInteger(item) || item <= 0 || !Array.isArray(options) || options.length < 2
    || options.some(option => typeof option !== 'string' || !option.trim())
    || new Set(options.map(option => option.trim())).size !== options.length) {
    throw new Refused('BAD_DECISION_OPTIONS', 'ask an item decision with at least two distinct nonempty options: pullboard shout coordinator "<question>" --item <id> --decision --options \'["first","second"]\'');
  }
  if (!itemShoutReader(board.db, item, from)) throw new Refused('NOT_YOUR_ITEM_DECISION', 'ask a decision on an item you build or review, or ask the coordinator for a cross-item decision');
  return { ...detail, decisionOptions: options.map(option => option.trim()) };
}

/** Retain normalized options/effects through escalation, never caller ownership or opaque legacy fields. */
export function recordItemDecision(board, id, { decision, answers, record }) {
  if (!decision) return;
  if (!record && answers !== null) {
    const original = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_decision:${answers}`);
    if (original) record = JSON.parse(original.meta_value);
  }
  if (record) board.db.prepare('INSERT INTO board_meta (meta_key,meta_value) VALUES (?,?)').run(`item_decision:${id}`, JSON.stringify(record));
}

/** Read metadata in one indexed batch; ordinary legacy decisions retain their original shape. */
export function projectItemDecisions(board, asks) {
  if (!asks.length) return asks;
  const keys = asks.map(ask => `item_decision:${ask.shout_id}`);
  const rows = board.db.prepare(`SELECT meta_key,meta_value FROM board_meta WHERE meta_key IN (${keys.map(() => '?').join(',')})`).all(...keys);
  const records = new Map(rows.map(row => [row.meta_key, JSON.parse(row.meta_value)]));
  return asks.map(ask => {
    const record = records.get(`item_decision:${ask.shout_id}`);
    return record ? { ...ask, item: record.item ?? shoutItemId(ask.shout_to),
      ...(record.options === undefined ? {} : { options: record.options }),
      ...(record.effects === undefined ? {} : { effects: record.effects }) } : ask;
  });
}
