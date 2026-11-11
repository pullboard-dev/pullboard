/**
 * The person authority this process read itself over TLS from a built-in relay origin, by board id (#408). Why not
 * the board's own row: any row the user's shell can write, an agent in that shell can write too, including the very
 * first pin, so every strict passkey check trusts only what this process fetched.
 */
const ATTESTED = new Map();

/** Remember the authority the relay vouched for, for this board id, for the rest of this process. */
export function rememberAttested(boardId, authority) {
  ATTESTED.set(boardId, authority);
}

/**
 * The relay-attested authority for a board id, or null when this process has not read one.
 *
 * @param {string | null} boardId
 * @returns {{ origin: string, publicKey: string } | null}
 */
export function attestedAuthority(boardId) {
  return ATTESTED.get(boardId) ?? null;
}
