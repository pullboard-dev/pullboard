import { machineBarDigest } from '../logic/verdict/machine-read.js';

/** Read the current explicit authorization without loading machine-verdict write operations. */
export function machineVerification(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`machine_verification:${item.item_id}`);
  const value = row ? JSON.parse(row.meta_value) : null;
  return value?.enabled === true && value.bar === machineBarDigest(item) ? value : null;
}
