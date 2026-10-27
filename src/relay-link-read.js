/** Read validated local link metadata without transport, token migration or a board write [C7,H5]. */
import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { Refused } from './refused.js';
import { relayOrigin } from './relay-origin.js';

/** Preserve the transport's private-file and metadata checks for lightweight local readers. */
export function readRelayLink(file) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'restore relay.json as an owner-only regular file with mode 600');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore valid relay link metadata before syncing this board'); }
  if (!state || typeof state !== 'object' || state.version !== 1 || !/^[0-9a-f]{32}$/.test(state.board) || !(state.token === undefined || state.personReauth && state.token === null || /^(ps_|pa_|pm_)[A-Za-z0-9_-]{43}$/.test(state.token)) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Refused('RELAY_STORAGE', 'restore supported relay link metadata before syncing this board');
  }
  relayOrigin(state.url);
  return state;
}
