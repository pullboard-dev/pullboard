import { outboxFile } from './summary.js';
import { readOutboxSummary } from './summary.js';
import { readRelayLink } from './read.js';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

export const STATE_FILES = new WeakMap();

/** Validate private link metadata before trusting its destination or acknowledgement cursor. */
export function loadLink(file) {
  const state = readRelayLink(file);
  if (!state) return null;
  if (state.token === undefined || state.token?.startsWith('ps_')) {
    state.token = null;
    delete state.tokenId;
    state.personReauth = true;
    saveLink(file, state);
  }
  STATE_FILES.set(state, file);
  // A move queues itself without the relay lock, so the outbox summary lives in its own file (#1013).
  const waiting = readOutboxSummary(file);
  if (waiting) state.outbox = waiting;
  else if (!fs.exists(outboxFile(file))) delete state.outbox;
  return state;
}

/** Atomically persist acknowledgements and an exact sealed retry before attempting its send. */
export function saveLink(file, state) {
  STATE_FILES.set(state, file);
  fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    // The outbox summary is the outbox's own file; a link saved by the sender never overwrites a move's (#1013).
    fs.writeFile(temporary, JSON.stringify({ ...state, outbox: undefined }) + '\n', { flag: 'wx', mode: 0o600 });
    fs.rename(temporary, file);
  } finally { fs.rm(temporary, { force: true }); }
}
