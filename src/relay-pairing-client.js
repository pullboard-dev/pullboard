import { hasPrivatePermissions, writePrivateFileSync } from './windows-private-storage.js';
/** CLI pairing flow: the relay stores only a one-use client-encrypted package [H15,H17]. */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { computerName } from './computer-name.js';
import {
  dirname,
  join,
} from 'node:path';
import * as store from './board.js';
import {
  exportBoard,
  importBoard,
  isInitialBoard,
} from './exchange.js';
import {
  codeIsFromMain,
  repoInfo,
} from './git.js';
import {
  forgetBoardKey,
  readBoardKey,
  storeBoardKey,
} from './relay-key.js';
import { encodeBoardKey } from './seal.js';
import {
  createPairingCode,
  openPairingBundle,
  parsePairingCode,
  sealPairingBundle,
} from './pairing.js';
import { terminalQr } from './qr.js';
import {
  DEFAULT_RELAY,
  originRepository,
  relayPersonCoordinator,
  syncRelay,
} from './relay.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import { requirePersonChannel } from './person.js';
import { updateRelayMachine } from './relay-machine.js';
import { listApiProjects } from './projects.js';

const TOKEN = /^pm_[A-Za-z0-9_-]{43}$/;
const BOARD = /^[0-9a-f]{32}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Restrict pairing traffic to a trusted HTTPS origin or a loopback test relay. */
function relayOrigin(address) {
  let url;
  try { url = new URL(address); } catch { throw new Refused('RELAY_URL', 'use an HTTPS relay address, such as https://app.pullboard.dev'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Refused('RELAY_URL', 'use an HTTPS relay origin without credentials, path, query or fragment; loopback HTTP is for local testing');
  }
  return url.origin;
}

/** Locate the private link metadata shared by this repository's worktrees. */
function linkFile(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'relay.json');
}

/** Load and validate relay state before it supplies a destination or credential. */
function loadState(file) {
  if (!existsSync(file)) throw new Refused('RELAY_NOT_LINKED', 'link this board with pullboard relay on before pairing a device');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !hasPrivatePermissions(file, stat)) throw new Refused('RELAY_STORAGE', 'restore relay.json as an owner-only regular file with mode 600');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore valid relay link metadata before pairing this board'); }
  if (!state || state.version !== 1 || !BOARD.test(state.board) || !TOKEN.test(state.token) ||
      typeof state.repository !== 'string' || !REPOSITORY.test(state.repository) ||
      (state.mode !== undefined && !['mirror', 'ordered'].includes(state.mode)) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Refused('RELAY_STORAGE', 'restore supported relay link metadata before pairing this board');
  }
  relayOrigin(state.url);
  return state;
}

/** Persist a joined-device link with owner-only permissions and atomic replacement. */
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writePrivateFileSync(Refused, temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Send one authenticated, bounded JSON request without including credentials in errors. */
async function relayRequest(url, token, path, body) {
  let response;
  try {
    response = await fetch(new URL(path, url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Refused('RELAY_UNAVAILABLE', 'the relay did not answer; retry pairing with the same code before it expires'); }
  let document;
  try { document = await response.json(); } catch { throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid pairing response; ask for a fresh code'); }
  if (!response.ok) throw new Refused(document.error?.code || 'RELAY_UNAVAILABLE', document.error?.message || 'the relay refused pairing; ask the linked device for a fresh code', document.error?.next);
  if (document.version !== 1) throw new Refused('RELAY_VERSION', 'the relay pairing API version is unsupported; upgrade Pullboard before pairing');
  return document;
}

/** Sign this device into the relay so its person session can fetch the encrypted package. */
async function signIn(url, io) {
  const start = await relayRequest(url, '', '/auth/device/start', {});
  io.stderr.write(`Sign in with GitHub: open ${start.verificationURL} and enter ${start.userCode}\n`);
  const deadline = Date.now() + start.expiresIn * 1000;
  let wait = start.interval;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1000));
    if (Date.now() >= deadline) throw new Refused('OAUTH_EXPIRED', 'GitHub device sign-in expired; run pullboard relay join again with a fresh code');
    const result = await relayRequest(url, '', '/auth/device/poll', { ticket: start.ticket });
    if (!result.pending) {
      if (!/^ps_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
      return result;
    }
    wait = result.retryAfter ?? start.interval;
  }
}

/** Return an exported local board with its persistent identity. */
function localSnapshot(root) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try { return { board: store.boardId(board), snapshot: exportBoard(board) }; }
  finally { store.closeBoard(board); }
}

/** Create a one-use code and publish only an encrypted board package to the relay. */
export async function relayPair(root, io) {
  const file = linkFile(root);
  loadState(file);
  // Freeze the native event boundary before asynchronous sync; retry if it changes during pairing.
  const initialCursor = localSnapshot(root).snapshot.tables.event.at(-1)?.event_id ?? 0;
  await syncRelay(root, io);
  const state = loadState(file);
  if (state.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish unlinking this board before creating a pairing code');
  if (originRepository(root) !== state.repository) throw new Refused('RELAY_ORIGIN', 'the origin repository no longer matches this relay link; restore the linked GitHub origin first');
  const local = localSnapshot(root);
  if (local.board !== state.board) throw new Refused('RELAY_STORAGE', 'the local board identity differs from its relay link; restore the matching board before pairing');
  const cursor = local.snapshot.tables.event.at(-1)?.event_id ?? 0;
  const metadata = new Map(local.snapshot.tables.board_meta.map((row) => [row.meta_key, row.meta_value]));
  const applied = metadata.get('relay_applied_sequence');
  const engine = metadata.get('relay_engine_version');
  const ordered = state.mode === 'ordered' || (applied !== undefined && engine !== undefined);
  // Mirror cursors count native events; ordered packages are guarded by their acknowledged relay prefix below.
  if (cursor !== initialCursor || (!ordered && cursor !== state.cursor)) throw new Refused('PAIR_BUSY', 'a local move changed during pairing; run pullboard relay pair again after sync completes');
  if (state.pending || state.pendingMove || state.snapshot || state.linkPending) {
    throw new Refused('PAIR_PENDING', 'finish the pending relay acknowledgement or snapshot before creating a pairing code; retry relay sync first');
  }
  let sequence = state.sequence;
  if (ordered) {
    const value = Number(applied);
    if (engine !== String(ENGINE_VERSION) || !Number.isSafeInteger(value) || value < 0 || String(value) !== applied || value !== state.sequence) {
      throw new Refused('PAIR_STATE', 'the ordered relay checkpoint does not match its acknowledged sequence; sync this device before pairing');
    }
    sequence = value;
  }
  const key = readBoardKey(state.board);
  const bundle = {
    version: 1, board: state.board, url: state.url, repository: state.repository,
    mode: ordered ? 'ordered' : 'mirror', sequence, cursor, key: encodeBoardKey(key), snapshot: local.snapshot,
  };
  const changed = () => {
    const current = localSnapshot(root);
    return current.board !== local.board || (current.snapshot.tables.event.at(-1)?.event_id ?? 0) !== cursor;
  };
  const busy = () => new Refused('PAIR_BUSY', 'a local move changed during pairing; run pullboard relay pair again after sync completes');
  const code = createPairingCode(state.board);
  const sealed = await sealPairingBundle(code.code, bundle);
  if (changed()) throw busy();
  const path = `/api/v1/pairings/${code.board}/${code.locator}`;
  const response = await relayRequest(state.url, state.token, path, { sealed });
  if (changed()) {
    // This code has never left this process. Discard its opaque package without exposing its secret.
    try { await relayRequest(state.url, state.token, path + '/consume', {}); }
    catch { io.err?.('pullboard: the unused pairing package could not be discarded; it expires within 10 minutes'); }
    throw busy();
  }
  // The board page lives on the relay this board is linked to, which may differ from the hosted default.
  const viewLink = state.url + '/#board=' + state.board;
  io.result?.({ code: code.code, link: viewLink, expiresIn: response.expiresIn });
  const address = state.url === DEFAULT_RELAY ? '' : ' --url ' + state.url;
  io.say(`For another computer: in its clone of this repository, run pullboard init, then pullboard relay join ${code.code}${address}. The code works once, for 10 minutes.`);
  io.say(`For a phone: scan this QR code, or open ${viewLink}. Pair a new phone first with pullboard relay on --all.`);
  io.say(terminalQr(viewLink));
  return 0;
}

/** Refuse a nonempty target board before spending its one-use code. */
function requireFreshTarget(root) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try {
    const eventLog = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('event_log_version');
    if (!isInitialBoard(board) || eventLog?.meta_value !== String(store.EVENT_LOG_VERSION)) {
      throw new Refused('IMPORT_NOT_EMPTY', 'pair into a freshly initialized clone with no board work; preserve this board and use another clone');
    }
  } finally { store.closeBoard(board); }
}

/** Refuse to overwrite an unrelated device key under the same persistent board id. */
function requireMissingKey(board) {
  try {
    readBoardKey(board);
    throw new Refused('RELAY_KEY_EXISTS', 'this clone already has a key for that board; preserve it and use a fresh device home');
  } catch (error) {
    if (error.code !== 'RELAY_KEY_MISSING') throw error;
  }
}

/** Consume a printed one-time code, restore the board and save this device's own link. */
export async function relayJoin(root, code, address, io, { name: labelInput } = {}) {
  const label = computerName(labelInput);
  requirePersonChannel(io.personChannel);
  const parsed = parsePairingCode(code);
  const url = relayOrigin(address || DEFAULT_RELAY);
  requireFreshTarget(root);
  requireMissingKey(parsed.board);
  const repository = originRepository(root);
  const signed = await signIn(url, io);
  const response = await relayRequest(url, signed.token,
    `/api/v1/pairings/${parsed.board}/${parsed.locator}/consume`, {});
  const bundle = await openPairingBundle(code, response.sealed);
  if (bundle.repository !== repository) throw new Refused('PAIR_REPOSITORY', 'this code belongs to another GitHub repository and was consumed; ask the linked device for a fresh code, then join inside the matching clone');
  if (new URL(bundle.url).origin !== new URL(url).origin) throw new Refused('PAIR_RELAY', 'this code belongs to another relay; rerun join with that relay address');
  const file = linkFile(root);
  if (existsSync(file)) throw new Refused('RELAY_LINKED', 'this clone already has relay link metadata; use a fresh clone to join another device');
  const machine = updateRelayMachine(state => state.machine);
  // Only a person's explicit label travels to other computers; never send this host or path.
  const issued = await relayRequest(url, signed.token, '/auth/machines', { board: bundle.board, machine, ...(label === undefined ? {} : { name: label }) });
  if (!TOKEN.test(issued.token) || issued.board !== bundle.board || issued.machine !== machine) throw new Refused('RELAY_RESPONSE', 'the relay did not issue this joined board’s machine credential; pair again');
  let keyStorage;
  try {
    keyStorage = storeBoardKey(bundle.board, Buffer.from(bundle.key, 'base64url'));
    const info = repoInfo(root);
    const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
    try { importBoard(board, bundle.snapshot); }
    finally { store.closeBoard(board); }
    saveState(file, {
      version: 1, board: bundle.board, url: bundle.url, repository: bundle.repository,
      mode: bundle.mode,
      token: issued.token, tokenId: issued.id, machine, account: signed.user.id, keyStorage,
      ...(label === undefined ? {} : { computerName: label }),
      sequence: bundle.sequence, cursor: bundle.cursor,
    });
  } catch (error) {
    if (keyStorage) {
      try { forgetBoardKey(bundle.board, keyStorage); } catch { /* Keep the original refusal as the useful next step. */ }
    }
    throw error;
  }
  // This machine's coordinator token comes from the same person sign-in, never the machine credential.
  await relayPersonCoordinator(root, signed.token, io);
  await syncRelay(root, io);
  const name = listApiProjects().find(project => project.root === repoInfo(root).root)?.name ?? bundle.repository;
  const notice = `Joined ${name}. This brought one board; for another, run pullboard relay pair in that board on the linked computer. Run pullboard status to read it.`;
  const result = { linked: true, board: bundle.board, name, url: bundle.url, sequence: bundle.sequence, behind: 0, notice };
  io.result?.(result);
  io.say(notice);
  return 0;
}
