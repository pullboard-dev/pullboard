/** Exercise a real CLI-to-relay round trip without printing device or board secrets [H5,H17,H18]. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Refused } from '../src/refused.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { readBoardKey } from '../src/relay-key.js';
import { unseal } from '../src/seal.js';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPOSITORY, 'bin', 'pullboard.js');

/** Run one production CLI command in the current repository and parse only its JSON document. */
function cli(root, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => process.stderr.write(part));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('the Pullboard command did not finish before its deadline'));
      if (code !== 0) return reject(new Error('the Pullboard command failed; read its message above and repair the repository before retrying'));
      try { resolveResult(JSON.parse(stdout)); }
      catch { reject(new Error('the Pullboard command did not return its JSON result')); }
    });
  });
}

/** Find the actual common Git directory for this repository, including linked worktrees. */
async function commonDirectory(root) {
  const result = await cliGit(root, ['rev-parse', '--git-common-dir']);
  return resolve(root, result.trim());
}

/** Run Git without a shell and return its bounded textual result. */
function cliGit(root, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveResult(stdout) : reject(new Error('run the smoke from an initialized Git repository')));
  });
}

/** Read an authenticated gzip checkpoint or its legacy JSON representation without printing contents. */
function snapshotDocument(bytes) {
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return JSON.parse(gunzipSync(bytes).toString('utf8'));
    if (bytes[0] !== 0x7b) throw new Refused('SNAPSHOT_FORMAT', `the sealed snapshot starts with ${Buffer.from(bytes.subarray(0, 4)).toString('hex') || 'no bytes'}; expected gzip magic 1f8b or legacy JSON starting with 7b`);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('SNAPSHOT_FORMAT', 'the sealed snapshot cannot be read; refresh it from a linked machine');
  }
}

/** Read one authenticated event and prove that the smoke-created item reached the relay. */
async function readMirroredMove({ address, board, token, key, after, item, title }) {
  const path = `/api/v1/boards/${board}/events?after=${after}`;
  const response = await fetch(new URL(path, address), { headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  if (!response.ok) {
    const refusal = await response.json().catch(() => ({}));
    if (refusal.error?.code === 'SNAPSHOT_REQUIRED') {
      return readMirroredCheckpoint({ address, board, token, key, after, item, title });
    }
    throw new Error('the relay did not return the mirrored move');
  }
  const document = await response.json();
  const event = document.events?.find((row) => row.event_id === after + 1 && row.kind === 'move');
  if (!event) throw new Error('the relay response did not include the next move');
  const bytes = await unseal(key, Buffer.from(event.sealed, 'base64url'), { boardId: board, kind: 'move', sequence: event.event_id });
  const move = JSON.parse(new TextDecoder().decode(bytes));
  if (move.operation === 'addItem') {
    if (move.args?.[0]?.title !== title) throw new Error('the decrypted relay operation is not the smoke item');
    const stateResponse = await fetch(new URL(`/api/v1/boards/${board}/state`, address), { headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': String(ENGINE_VERSION) } });
    if (!stateResponse.ok) throw new Error('the relay did not return its native checkpoint');
    const saved = await stateResponse.json();
    const checkpointBytes = await unseal(key, Buffer.from(saved.state.sealed, 'base64url'), {
      boardId: board, kind: 'snapshot', sequence: saved.state.sequence,
    });
    const checkpoint = snapshotDocument(checkpointBytes);
    const row = checkpoint.tables?.item?.find((candidate) => candidate.item_id === item.item_id && candidate.item_title === title);
    const applied = checkpoint.tables?.board_meta?.find((candidate) => candidate.meta_key === 'relay_applied_sequence')?.meta_value;
    if (saved.state.sequence !== event.event_id || Number(applied) !== event.event_id || !row) {
      throw new Error('the native checkpoint does not cover the mirrored smoke item');
    }
  } else if (move.version === 1 && move.engine === 1 && move.event?.event_kind === 'add') {
    if (move.event.item_id !== item.item_id || item.item_title !== title) throw new Error('the decrypted relay add does not match the smoke item');
  } else throw new Error('the relay move format is unsupported');
  return event.event_id;
}

/** Read a compacted move from its authenticated native checkpoint when the event tail is gone. */
async function readMirroredCheckpoint({ address, board, token, key, after, item, title }) {
  const response = await fetch(new URL(`/api/v1/boards/${board}/state`, address), { headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  if (!response.ok) throw new Error('the relay did not return the mirrored checkpoint');
  const saved = await response.json();
  const sequence = saved.state?.sequence;
  if (!Number.isSafeInteger(sequence) || sequence !== after + 1 || typeof saved.state.sealed !== 'string') {
    throw new Error('the relay checkpoint does not cover exactly one smoke move');
  }
  const bytes = await unseal(key, Buffer.from(saved.state.sealed, 'base64url'), {
    boardId: board, kind: 'snapshot', sequence,
  });
  const checkpoint = snapshotDocument(bytes);
  const row = checkpoint.tables?.item?.find((candidate) => candidate.item_id === item.item_id && candidate.item_title === title);
  const applied = checkpoint.tables?.board_meta?.find((candidate) => candidate.meta_key === 'relay_applied_sequence')?.meta_value;
  if (Number(applied) !== sequence || !row) throw new Error('the authenticated checkpoint does not contain the smoke move');
  return sequence;
}

/** Run relay on, add and unseal one move, then always issue relay off against the supplied origin. */
async function smoke(address) {
  const root = process.cwd();
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const lane = Object.keys(config.lanes || {})[0];
  if (!lane) throw new Error('the smoke repository must have at least one configured lane');
  const common = await commonDirectory(root);
  const metadata = join(common, 'pullboard', 'relay.json');
  if (existsSync(metadata)) throw new Error('this repository already has a relay link; use an unlinked throwaway repository');
  let on;
  let linked = false;
  let failure;
  let result;
  try {
    on = await cli(root, ['relay', 'on', '--url', address]);
    linked = existsSync(metadata);
    if (!on.linked || on.url !== new URL(address).origin) throw new Error('relay on did not link to the supplied address');
    const title = `Pullboard relay smoke ${Date.now()}`;
    const added = await cli(root, ['add', lane, title]);
    const item = added.item;
    if (!item || typeof item.item_id !== 'number') throw new Error('the local add did not return its item');
    const link = JSON.parse(readFileSync(metadata, 'utf8'));
    if (link.board !== on.board || link.url !== on.url) throw new Error('the saved relay link changed during the smoke');
    const mode = statSync(metadata).mode & 0o777;
    if (mode !== 0o600) throw new Error('the saved relay link is not private');
    const eventId = await readMirroredMove({
      address: on.url,
      board: on.board,
      token: link.token,
      key: readBoardKey(on.board),
      after: on.sequence,
      item,
      title,
    });
    result = { ok: true, board: on.board, item: item.item_id, sequence: eventId };
  } catch (error) {
    linked ||= existsSync(metadata);
    failure = error;
  }
  if (linked) {
    try {
      const off = await cli(root, ['relay', 'off']);
      if (result) { result.remoteCopyRetained = true; result.notice = off.notice; }
    }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  process.stdout.write(JSON.stringify(result) + '\n');
}

const address = process.argv[2];
if (!address) {
  process.stderr.write('usage: node relay/smoke.mjs <address>\n');
  process.exitCode = 2;
} else {
  try { await smoke(address); }
  catch (error) {
    process.stderr.write(`relay smoke failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
