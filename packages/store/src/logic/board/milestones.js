import { Refused } from "../../../../kernel/light.js";

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
