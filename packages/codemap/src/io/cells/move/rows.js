/**
 * A cited spec row that changed without a rewrite edit refuses, naming the coordinator [B4,R2,#5704].
 * Why: a rewrite edit refreezes a bar at the live row text, so a bar still frozen at older text was never rewritten;
 * only the coordinator may rewrite it. The refusal ships behind verify.requireRowRewrite, off by default.
 */
import { Refused } from '../../../../../kernel/index.js';

/** Statuses whose bar is closed: landed work keeps the words it landed with. */
const CLOSED = new Set(['withdrawn', 'landed', 'verified']);

/**
 * The open items whose frozen cited rows no longer read as they did, with no rewrite edit recorded since: an edit that
 * rewrites a bar refreezes it at the live row text, so a bar still frozen at old text was never rewritten.
 *
 * @param {{ item_id: number, item_status: string, item_frozen?: string | null }[]} items
 * @param {{ id: string, text: string }[]} rows - The live spec rows.
 * @returns {{ id: number, rows: string[] }[]}
 */
export function unrewrittenRows(items, rows) {
  const live = new Map(rows.map(row => [row.id, row.text]));
  const found = [];
  for (const item of items) {
    if (CLOSED.has(item.item_status) || !item.item_frozen) continue;
    const frozen = JSON.parse(item.item_frozen);
    const changed = (frozen.rows ?? []).filter(row => live.has(row.id) && live.get(row.id) !== row.text).map(row => row.id);
    if (changed.length) found.push({ id: item.item_id, rows: changed });
  }
  return found;
}

/**
 * Refuse while any open item cites a spec row whose text changed without a rewrite edit, naming the coordinator.
 * Does nothing unless the setting is on.
 *
 * @param {{ item_id: number, item_status: string, item_frozen?: string | null }[]} items
 * @param {{ id: string, text: string }[]} rows
 * @param {{ enabled?: boolean }} [options] - enabled: the verify.requireRowRewrite setting.
 * @throws {Refused} ROW_REWRITE_MISSING
 */
export function requireRewrittenRows(items, rows, { enabled = false } = {}) {
  if (enabled !== true) return;
  const [first] = unrewrittenRows(items, rows);
  if (!first) return;
  throw new Refused('ROW_REWRITE_MISSING', `item #${first.id} cites ${first.rows.join(', ')}, whose text changed with no rewrite edit recorded for its bar`,
    `ask the coordinator to rewrite its bar: pullboard edit ${first.id} --criterion "<text>" --reason "<why ${first.rows[0]} changed>"`);
}
