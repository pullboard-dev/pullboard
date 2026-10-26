/** Keep explicit local unlinking distinct from joining somebody else's existing remote board [H17]. */
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from './git.js';
import { Refused } from './refused.js';

/** Locate the key-free next-epoch intent beside the shared local board. */
function markerFile(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'relay-relink.json');
}

/** Read a bounded private intent; it supplies identity, never a key, token or relay destination. */
export function relayRelink(root) {
  const file = markerFile(root);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 1024) {
    throw new Refused('RELAY_STORAGE', 'restore the private relink intent before linking this board');
  }
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('RELAY_STORAGE', 'restore the private relink intent before linking this board'); }
  if (value?.version !== 1 || !/^[0-9a-f]{32}$/u.test(value.previous ?? '')
      || !/^[0-9a-f]{32}$/u.test(value.next ?? '') || value.previous === value.next) {
    throw new Refused('RELAY_STORAGE', 'restore the supported relink intent before linking this board');
  }
  return value;
}

/** Bind phone approval and native snapshot preparation to the same durable fresh board identity. */
export function plannedRelayBoard(root, current) {
  const marker = relayRelink(root);
  if (!marker) return current;
  if (current !== marker.previous && current !== marker.next) {
    throw new Refused('RELAY_STORAGE', 'the relink intent belongs to another local board; restore its matching board before linking');
  }
  return marker.next;
}

/** Persist the next identity before OFF forgets the only local key, without changing native history. */
export function rememberRelink(root, previous) {
  const existing = relayRelink(root);
  if (existing?.previous === previous) return existing;
  const value = { version: 1, previous, next: randomBytes(16).toString('hex') };
  const file = markerFile(root);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return value;
}

/** Retain old encrypted queued obligations without replaying their already-local effects into a new epoch. */
export function archiveRelinkOutbox(root, state) {
  const directory = join(repoInfo(root).commonDir, 'pullboard');
  const file = join(directory, 'relay-outbox.sealed');
  const queued = existsSync(file);
  const records = [state.pending, state.recovered].filter(record => typeof record?.sealed === 'string')
    .map(record => ({ sequence: record.sequence, sealed: record.sealed }));
  if (!queued && !records.length) return;
  const name = 'relay-outbox-' + state.board + '-' + randomUUID();
  writeFileSync(join(directory, name + '.json'), JSON.stringify({ version: 1, board: state.board,
    url: state.url, sequence: state.sequence, machine: state.machine, records,
    ...(queued ? { encryptedFile: name + '.sealed' } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
  if (queued) renameSync(file, join(directory, name + '.sealed'));
}

/** Consume the intent only after the new link and its exact sealed baseline are durable. */
export function finishRelink(root) {
  rmSync(markerFile(root), { force: true });
}

/** A confirmed deleted copy has no active link to retire; retained OFF intents still name theirs. */
export function relinkReplacement(state, relink, deletedBoard) {
  const previous = state?.replaces ?? relink?.previous;
  if (previous && previous === deletedBoard) {
    if (state) { delete state.replaces; delete state.previousBoardNotice; }
    return null;
  }
  return previous;
}
