/** A stable seat address identifies a board and recipient; it never grants permission to that board [H2,H16]. */
import { Refused } from '../../../kernel/browser.js';

/** Encode the persistent board identity and seat id, independently of a checkout path or machine. */
export function seatAddress(boardId, agentId) {
  return `pullboard:${boardId}:${encodeURIComponent(agentId)}`;
}

/** Resolve only addresses for this board; ordinary lane and seat names keep their existing meaning. */
export function addressedSeat(value, boardId) {
  if (typeof value !== 'string' || !value.startsWith('pullboard:')) return value;
  const match = /^pullboard:([0-9a-f]{32}):(.+)$/u.exec(value);
  let agent;
  try { agent = match && decodeURIComponent(match[2]); } catch { agent = null; /* Malformed address bytes never select a recipient. */ }
  if (!agent || seatAddress(match[1], agent) !== value) {
    throw new Refused('NO_READER', 'copy the exact seat address from pullboard whoami or pullboard agents');
  }
  if (match[1] !== boardId) {
    throw new Refused('SEAT_ADDRESS_BOARD', 'this address belongs to another board; open a linked checkout of that board with your own grant before sending');
  }
  return agent;
}
