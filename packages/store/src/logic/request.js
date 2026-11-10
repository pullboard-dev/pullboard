/** Bind explicit reviewer requests to the frozen criterion or check [V6,R2,H16]. */
import { Refused } from '../../../kernel/light.js';

/** Normalize a quotation without changing its words. */
const wording = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Return the quote only when this is a live reviewer's request to its builder. */
export function reviewRequestClause(board, { from, to, item, text, kind, clause }) {
  if (kind !== 'request') return null;
  const ids = item === undefined ? [...new Set([...String(text).matchAll(/#(\d+)/gu)].map(match => Number(match[1])))] : [item];
  const read = board.db.prepare('SELECT item_id,item_status,item_built_by,item_review_by,item_review_until,item_frozen FROM item WHERE item_id=?');
  const targets = ids.map(id => read.get(id)).filter(row => row && row.item_status === 'submitted'
    && row.item_review_by === from && row.item_review_until > board.clock.now().toISOString()
    && (item !== undefined || to === row.item_built_by));
  if (!targets.length) return null;
  if (typeof clause !== 'string' || !wording(clause)) throw new Refused('BAR_CLAUSE_REQUIRED',
    'a reviewer request names the frozen requirement or check', 'add --clause "exact wording from the frozen criterion or check"');
  const quote = wording(clause);
  for (const row of targets) {
    let frozen;
    try { frozen = JSON.parse(row.item_frozen); } catch { frozen = { criterion: row.item_frozen }; }
    const parts = [frozen?.criterion, frozen?.check, ...(Array.isArray(frozen?.rows) ? frozen.rows.map(entry => entry.text) : [])].map(wording);
    if (quote.length > 4096 || !parts.some(part => part && part.includes(quote))) throw new Refused('BAR_CLAUSE_UNKNOWN',
      'the request quote does not match the frozen criterion or check', `read pullboard show ${row.item_id}, then quote its frozen requirement with --clause`);
  }
  return quote;
}
