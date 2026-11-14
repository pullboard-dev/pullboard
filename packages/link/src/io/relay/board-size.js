/** relay on refuses a board too large for the relay, before it changes anything (#7777) [B26,H16,H17]. */
import { statSync } from 'node:fs';
import { boardFilePath } from '../../../../store/index.js';
import { Refused } from '../../../../kernel/light.js';
import { formatPresentationLimit } from '../../logic/relay/size.js';
import { presentationRoom } from '../../logic/relay/size.js';

/**
 * Refuse a board too large for its presentation to be built: no pullboard.json edit, no board id and no link.
 * The stored board's size stands in for the presentation it would seal.
 */
export function requireBoardFitsRelay(commonDir) {
  const base = boardFilePath(commonDir);
  let bytes = 0;
  for (const file of [base, base + '-wal']) { try { bytes += statSync(file).size; } catch { /* A board with no write-ahead log is just its file. */ } }
  const over = presentationRoom(bytes, process.env.PULLBOARD_RELAY_PRESENTATION_LIMIT);
  if (over) throw new Refused('RELAY_BOARD_TOO_LARGE', `${formatPresentationLimit(over)}; relay on changed nothing; keep working locally, or shrink the board under ${(over.limit / 1_000_000).toFixed(1)} MB and run pullboard relay on again`);
}
