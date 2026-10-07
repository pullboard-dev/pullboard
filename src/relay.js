/** Opt-in, local-first sealed mirroring; relay-first execution is a later stage [H1,H7,P5]. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as store from './board.js';
import { exportBoard } from './exchange.js';
import { repoInfo, tryGit } from './git.js';
import { forgetBoardKey, readBoardKey, storeBoardKey } from './relay-key.js';
import { encodeBoardKey, generateBoardKey, seal } from './seal.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';

export const DEFAULT_RELAY = 'https://app.pullboard.dev';

/** Require a trusted origin; HTTP exists only for loopback development and test relays. */
function relayOrigin(address) {
  let url;
  try { url = new URL(address); } catch { throw new Refused('RELAY_URL', 'use an HTTPS relay address, such as https://app.pullboard.dev'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Refused('RELAY_URL', 'use an HTTPS origin without credentials, a path, query or fragment; loopback HTTP is allowed for a local relay');
  }
  return url.origin;
}

/** Resolve the GitHub owner/repository named by the actual origin remote, never a guessed repo. */
export function originRepository(root) {
  const remote = tryGit(root, ['remote', 'get-url', 'origin']);
  if (remote.status !== 0) throw new Refused('RELAY_ORIGIN', 'add a GitHub origin remote before running pullboard relay on');
  let repository;
  const ssh = /^git@github\.com:([^\s?#]+)$/.exec(remote.stdout);
  if (ssh) repository = ssh[1];
  else {
    try {
      const url = new URL(remote.stdout);
      if (url.hostname === 'github.com' && !url.password && !url.search && !url.hash &&
          ((url.protocol === 'https:' && !url.username) || (url.protocol === 'ssh:' && url.username === 'git')) && !url.port) repository = url.pathname.slice(1);
    } catch { /* A local path or another host is not a GitHub repository. */ }
  }
  repository = repository?.replace(/\.git$/, '');
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some((part) => ['.', '..'].includes(part))) {
    throw new Refused('RELAY_ORIGIN', 'origin must name a GitHub owner/repository using HTTPS or git SSH; fix origin and run pullboard relay on');
  }
  return repository;
}

/** Find the shared local link metadata without opening a board or connecting for an unlinked repo. */
function linkFile(root) { return join(repoInfo(root).commonDir, 'pullboard', 'relay.json'); }

/** Validate private link metadata before trusting its destination or acknowledgement cursor. */
function loadLink(file) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'restore relay.json as an owner-only regular file with mode 600');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore valid relay link metadata before syncing this board'); }
  if (!state || typeof state !== 'object' || state.version !== 1 || !/^[0-9a-f]{32}$/.test(state.board) || !/^ps_[A-Za-z0-9_-]{43}$/.test(state.token) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Refused('RELAY_STORAGE', 'restore supported relay link metadata before syncing this board');
  }
  relayOrigin(state.url);
  return state;
}

/** Atomically persist acknowledgements and an exact sealed retry before attempting its send. */
function saveLink(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Wait briefly for another worktree's upload, recovering a lock only when its owner is gone. */
async function locked(file, work) {
  const lock = file + '.lock';
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 15000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'pid'), String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (dead) { if (dead.code === 'ESRCH') { rmSync(lock, { recursive: true, force: true }); continue; } }
        }
      } catch {
        try { if (Date.now() - lstatSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } }
        catch (gone) { if (gone.code === 'ENOENT') continue; throw gone; }
      }
      if (Date.now() >= deadline) throw new Refused('RELAY_BUSY', 'another worktree is sending this board; the local move is safe and the next command retries');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Surface retention notices on the very command that receives them, without exposing credentials. */
function notices(document, io) {
  const warnings = [document.warning, document.state?.warning, ...(document.warnings ?? [])].filter(Boolean);
  for (const warning of warnings) if (warning.code === 'BOARD_INACTIVE') {
    io.err(`pullboard: [BOARD_INACTIVE] ${warning.daysLeft} days left before this relay board is deleted; ${warning.next || 'make a board move before the deadline to keep it'}`);
  }
}

/** The sole outbound transport in the CLI: explicit sign-in or a saved, opted-in board link. */
async function request(state, path, { method = 'GET', body } = {}, io) {
  let response;
  try {
    response = await fetch(relayOrigin(state.url) + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { ...(state.token ? { authorization: 'Bearer ' + state.token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Refused('RELAY_UNAVAILABLE', 'the relay did not answer; the local board is safe and the next command retries pending sends'); }
  let document;
  try { document = await response.json(); } catch { throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid response; retry with the configured relay address'); }
  notices(document, io);
  if (!response.ok) throw new Refused(document.error?.code || 'RELAY_UNAVAILABLE', (document.error?.code === 'AUTH_REQUIRED' ? 'the relay sign-in expired or was revoked; run pullboard relay on to sign in again without changing the board key' : document.error?.message) || 'the relay refused this send; the next command retries it');
  if (document.version !== 1) throw new Refused('RELAY_VERSION', 'the relay API version is unsupported; upgrade Pullboard before syncing');
  return document;
}

/** Read durable local event rows; their ids are the crash-safe outbox after the saved cursor. */
function localRecords(root, work) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Count unapplied uploads using durable event ids, without counting relay transport metadata. */
function behind(root, state) {
  return localRecords(root, (board) => board.db.prepare('SELECT COUNT(*) AS count FROM event WHERE event_id > ?').get(state.cursor).count);
}

/** Expose pairing information while keeping the human relay credential out of output. */
function summary(root, state) {
  if (!state) return { linked: false, board: '', url: '', link: '', sequence: 0, behind: 0 };
  if (state.unlinking) return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, cleanup: true };
  const key = encodeBoardKey(readBoardKey(state.board));
  return { linked: true, board: state.board, url: state.url,
    link: 'https://app.pullboard.dev/#board=' + state.board + '&key=' + key,
    sequence: state.sequence, behind: behind(root, state) + Number(Boolean(state.snapshot)) };
}

/** Seal a client record at its proposed public sequence, with no board key in its envelope. */
async function sealedRecord(key, value, state, kind, sequence) {
  return Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(value)), { boardId: state.board, kind, sequence })).toString('base64url');
}

/** Catch up in local order, retaining exact ciphertext so a lost response cannot duplicate a move. */
async function flush(root, file, state, io) {
  const key = readBoardKey(state.board);
  const path = '/api/v1/boards/' + state.board;
  if (state.linkPending) {
    await request(state, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository: state.repository } }, io);
    delete state.linkPending;
    saveLink(file, state);
  }
  if (state.snapshot) {
    const uploaded = await request(state, path + '/state', { method: 'PUT', body: state.snapshot }, io);
    if (uploaded.state?.sequence !== state.snapshot.sequence || uploaded.state.sealed !== state.snapshot.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the queued snapshot; retry the configured relay');
    delete state.snapshot;
    saveLink(file, state);
  }
  // Reading on every linked command also delivers the relay's inactivity warning.
  const remote = await request(state, path + '/events?after=' + state.sequence, {}, io);
  const received = remote.events;
  if (!Array.isArray(received) || received.some((event, index) => !event ||
      event.event_id !== (index ? received[index - 1].event_id : state.sequence) + 1 ||
      !['move', 'request'].includes(event.kind) || typeof event.sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(event.sealed))) {
    throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered event prefix; retry the configured relay');
  }
  if (state.pending) {
    const accepted = received.find((event) => event.event_id === state.pending.sequence && event.sealed === state.pending.sealed && event.kind === 'move');
    if (accepted) { state.cursor = state.pending.localEvent; delete state.pending; }
  }
  if (received.length) state.sequence = Math.max(state.sequence, ...received.map((event) => event.event_id));
  if (state.pending && state.pending.sequence <= state.sequence) delete state.pending;
  saveLink(file, state);
  const rows = localRecords(root, (board) => store.events(board).filter((event) => event.event_id > state.cursor));
  for (const event of rows) {
    if (!state.pending) {
      const sequence = state.sequence + 1;
      state.pending = { localEvent: event.event_id, sequence,
        sealed: await sealedRecord(key, { version: 1, engine: 1, event }, state, 'move', sequence) };
      saveLink(file, state);
    }
    const { sequence, sealed } = state.pending;
    const reply = await request(state, path + '/moves', { method: 'POST', body: { sequence, sealed } }, io);
    if (reply.event?.event_id !== sequence || reply.event.sealed !== sealed) throw new Refused('RELAY_RESPONSE', 'the relay acknowledgement does not match the queued record; retry after checking the relay');
    state.sequence = sequence;
    state.cursor = event.event_id;
    delete state.pending;
    saveLink(file, state);
  }
  return summary(root, state);
}

/** Retry an opted-in board before/after a CLI command; transport failure never undoes a local move. */
export async function syncRelay(root, io) {
  const file = linkFile(root);
  if (!existsSync(file)) return null;
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return null;
    if (state.unlinking) { io.err('pullboard: [RELAY_UNLINK_PENDING] the remote board is deleted; run pullboard relay off to finish forgetting this device key'); return summary(root, state); }
    try { return await flush(root, file, state, io); }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      io.err(`pullboard: ${error.message}; run pullboard status to see pending uploads`);
      return { linked: true, board: state.board, url: state.url, sequence: state.sequence,
        behind: behind(root, state) + Number(Boolean(state.snapshot)) };
    }
  });
}

/** Read the local link and lag without opening a network connection or revealing its relay token. */
export function relayStatus(root) { return summary(root, loadLink(linkFile(root))); }

/** Renew a person session through the relay without changing this device's board key or cursors. */
async function deviceSignIn(url, io) {
  const client = { url };
  const flow = await request(client, '/auth/device/start', { method: 'POST', body: {} }, io);
  io.stderr.write(`Sign in with GitHub: open ${flow.verificationURL} and enter ${flow.userCode}\n`);
  const expires = Date.now() + flow.expiresIn * 1000;
  let signed;
  let wait = flow.interval;
  do {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1000));
    if (Date.now() >= expires) throw new Refused('OAUTH_EXPIRED', 'GitHub device sign-in expired; run pullboard relay on again');
    signed = await request(client, '/auth/device/poll', { method: 'POST', body: { ticket: flow.ticket } }, io);
    wait = signed.retryAfter ?? flow.interval;
  } while (signed.pending);
  const token = signed.token;
  if (!/^ps_[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
  return signed;
}

/** Explicitly sign in through the relay and persist a sealed initial snapshot before uploading it. */
export async function relayOn(root, address, io) {
  const repository = originRepository(root);
  const file = linkFile(root);
  return locked(file, async () => {
    let state = loadLink(file);
    if (state?.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish this device key cleanup with pullboard relay off before linking again');
    const url = relayOrigin(address || state?.url || DEFAULT_RELAY);
    if (state && (state.url !== url || state.repository !== repository)) throw new Refused('RELAY_LINKED', 'this board is linked to another relay or repository; run relay off before changing its link');
    const key = state ? readBoardKey(state.board) : await generateBoardKey();
    const signed = await deviceSignIn(url, io);
    if (!state) {
      const snapshot = localRecords(root, (board) => ({ board: store.boardId(board), document: exportBoard(board) }));
      // Save the device key before creating any remote link; a locked keychain cannot strand it.
      const keyStorage = storeBoardKey(snapshot.board, key);
      state = { version: 1, board: snapshot.board, url, repository, token: signed.token,
        tokenId: signed.id, keyStorage, sequence: 0, cursor: snapshot.document.tables.event.at(-1)?.event_id ?? 0, linkPending: true };
      state.snapshot = { sequence: 0, sealed: await sealedRecord(key, snapshot.document, state, 'snapshot', 0) };
    } else { state.token = signed.token; state.tokenId = signed.id; }
    // Persist the exact sealed snapshot and a recoverable link intent before making the remote link.
    saveLink(file, state);
    if (state.linkPending) {
      await request(state, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository } }, io);
      delete state.linkPending;
      saveLink(file, state);
    }
    let result;
    try { result = await flush(root, file, state, io); }
    catch (error) { if (!(error instanceof Refused)) throw error; io.err(`pullboard: ${error.message}; pending records are queued for the next command`); result = summary(root, state); }
    io.say(terminalQr(result.link));
    return result;
  });
}

/** Remove the remote board and its link before forgetting this device's private key and metadata. */
export async function relayOff(root, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return summary(root, null);
    if (!state.unlinking) {
      await request(state, '/api/v1/boards/' + state.board, { method: 'DELETE' }, io);
      state.unlinking = true;
      saveLink(file, state);
    }
    forgetBoardKey(state.board, state.keyStorage);
    rmSync(file, { force: true });
    return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0 };
  });
}
