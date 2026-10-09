/** Offline SSH signature handling for spec sign-offs and signer-list transitions [S17,S18,S19,S20,S21]. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Refused } from './refused.js';

export const SIGNERS_FILE = '.pullboard/signers';
export const FIRST_COMMIT_FILE = '.pullboard/first-commit';
const INITIAL_SIGNERS_HASH_FILE = '.pullboard/signers.initial';
export const SIGNOFF_NAMESPACE = 'pullboard-signoff';
const verifiedRows = new WeakSet();

/** Identify receipts verified against this repo's SSH signer list, without persisting a trust flag. */
export function isVerifiedSignoff(record) { return verifiedRows.has(record); }

/** Hash the exact bytes the repo stores, so whitespace changes are signed changes too. */
export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

/** Run a git or ssh-keygen command and turn expected tool failures into a typed refusal. */
function runTool(command, args, { cwd, input, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: inherit ? ['inherit', 'pipe', 'pipe'] : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || `${command} exited ${result.status}`).trim();
    throw new Refused('SSH_KEY_FAILED', `${command} failed: ${detail}; check the SSH key and ssh-keygen installation`);
  }
  return (result.stdout ?? '').trim();
}

/** Read Git's configured identity or signing key from its normal config chain. */
function gitSetting(root, key) {
  const result = spawnSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Resolve the public or private key path supplied by the caller or the repo's Git settings. */
function keyPath(root, requested, privateKey) {
  let value = requested || gitSetting(root, 'user.signingkey');
  if (!value) value = join(homedir(), privateKey ? '.ssh/id_ed25519' : '.ssh/id_ed25519.pub');
  if (/^(?:ssh-|ecdsa-|sk-)/u.test(value)) throw new Refused('NOT_SSH_KEY_PATH', 'user.signingkey must name an SSH key file, not inline key data or a GPG key');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  const path = resolve(root, expanded);
  const privatePath = path.endsWith('.pub') ? path.slice(0, -4) : path;
  const candidates = privateKey ? [privatePath] : [path, `${privatePath}.pub`];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Refused('SSH_KEY_NOT_FOUND', `SSH key file ${path} was not found; set git user.signingkey or use --key <path>`);
  return found;
}

/** Convert a public key or private key file to the public OpenSSH key line. */
function publicKey(root, requested) {
  const path = keyPath(root, requested, false);
  let line;
  if (path.endsWith('.pub')) line = readFileSync(path, 'utf8').trim().split(/\r?\n/u)[0];
  else line = runTool('ssh-keygen', ['-y', '-f', path], { cwd: root, inherit: true });
  const [type, encoded, ...comment] = line.split(/\s+/u);
  if (!/^(?:ssh-|ecdsa-|sk-)/u.test(type ?? '') || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded ?? '')) {
    throw new Refused('NOT_SSH_KEY', 'the selected file is not an OpenSSH public key; GPG keys are not supported');
  }
  return `${type} ${encoded}${comment.length ? ` ${comment.join(' ')}` : ''}`;
}

/** Return the private half corresponding to a configured or explicitly named public key. */
function privateKey(root, requested) { return keyPath(root, requested, true); }

/** Read the signers file as exact UTF-8 text or return the empty initial state. */
export function readSignerText(root) {
  const file = join(root, SIGNERS_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Treat the existence of the signer file as opt-in, including an incomplete empty file. */
export function hasSignerFile(root) { return existsSync(join(root, SIGNERS_FILE)); }

/** Refuse required SSH principals that have no configured allowed-signers entry. */
export function assertRequiredSigners(root, rows) {
  const required = rows.filter((row) => row.signers?.length);
  if (!required.length) return;
  if (!hasSignerFile(root)) throw new Refused('NO_SIGNERS', 'rows naming signers need an SSH signer list; run pullboard spec signers add');
  const allowed = readSignerText(root);
  for (const row of required) {
    for (const principal of row.signers) {
      if (!listsPrincipal(allowed, principal)) throw new Refused('UNLISTED_SIGNER', `${row.id} names ${principal}, which is not listed; run pullboard spec signers add --by ${principal} --key <path>`);
    }
  }
}

/** Find a valid principal in an OpenSSH allowed-signers file. */
export function listsPrincipal(text, principal) {
  return text.split(/\r?\n/u).filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .some((line) => line.trim().split(/\s+/u)[0].split(',').includes(principal));
}

/** Match the configured Git signing key to a principal already present in an allowed-signer list. */
function principalForSigningKey(root, allowed) {
  const identity = publicKey(root, privateKey(root));
  const [type, blob] = identity.split(/\s+/u);
  for (const line of allowed.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const keyIndex = fields.findIndex((field) => /^(?:ssh-|ecdsa-|sk-)/u.test(field));
    if (fields[keyIndex] === type && fields[keyIndex + 1] === blob) return fields[0].split(',')[0];
  }
  throw new Refused('UNAUTHORIZED_SIGNERS_CHANGE', 'git user.signingkey is not a key already listed; set it to an authorized SSH private key');
}

/** Read the immutable first commit recorded at opt-in. */
export function readFirstCommit(root) {
  const file = join(root, FIRST_COMMIT_FILE);
  if (!existsSync(file)) throw new Refused('NO_FIRST_COMMIT', `missing ${FIRST_COMMIT_FILE}; run pullboard spec signers add`);
  const commit = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Refused('BAD_FIRST_COMMIT', `${FIRST_COMMIT_FILE} must contain the repo's first commit id`);
  return commit;
}

/** Read the first signer-list hash that every later signed receipt binds. */
function readInitialSignerHash(root) {
  const file = join(root, INITIAL_SIGNERS_HASH_FILE);
  if (!existsSync(file)) throw new Refused('BAD_SIGNERS_BASE', `missing ${INITIAL_SIGNERS_HASH_FILE}; restore the initial signer-list hash`);
  const hash = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Refused('BAD_SIGNERS_BASE', `${INITIAL_SIGNERS_HASH_FILE} must contain a SHA-256 hash`);
  return hash;
}

/** Serialize canonical signed content with stable field order. */
export function canonical(record) {
  if (record.type === 'row-decision') {
    return JSON.stringify({ version: 1, type: record.type, firstCommit: record.firstCommit, initialHash: record.initialHash, id: record.id, file: record.file, kind: record.kind, source: record.source, replacement: record.replacement, text: record.text, decision: record.decision, reason: record.reason, commit: record.commit, by: record.by, on: record.on, note: record.note ?? '' });
  }
  if (record.type === 'signers') {
    return JSON.stringify({ version: 1, type: record.type, firstCommit: record.firstCommit, initialHash: record.initialHash, previousHash: record.previousHash, previousSigners: record.previousSigners, hash: record.hash, by: record.by, on: record.on });
  }
  return JSON.stringify({ version: 1, type: 'row', firstCommit: record.firstCommit, initialHash: record.initialHash, id: record.id, text: record.text, commit: record.commit, by: record.by, on: record.on, note: record.note ?? '' });
}

/** Sign canonical text with ssh-keygen under the fixed Pullboard namespace. */
export function makeSignature(root, record, requestedKey) {
  const dir = join(tmpdir(), `pullboard-signature-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const message = join(dir, 'message');
  try {
    writeFileSync(message, canonical(record));
    runTool('ssh-keygen', ['-Y', 'sign', '-f', privateKey(root, requestedKey), '-n', SIGNOFF_NAMESPACE, message], { cwd: root, inherit: true });
    return readFileSync(`${message}.sig`, 'utf8').trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Verify a signature using an exact allowed-signers snapshot and the named principal. */
export function verifySignature(record, allowedText) {
  const dir = join(tmpdir(), `pullboard-verify-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const allowed = join(dir, 'allowed_signers');
  const signature = join(dir, 'record.sig');
  try {
    writeFileSync(allowed, allowedText);
    writeFileSync(signature, `${record.signature ?? ''}\n`);
    runTool('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', record.by, '-n', SIGNOFF_NAMESPACE, '-s', signature], { cwd: dir, input: canonical(record) });
    return true;
  } catch (error) {
    if (error instanceof Refused) throw new Refused('BAD_SIGNATURE', `sign-off by ${record.by ?? '(unknown)'} has an invalid signature or unlisted SSH key`);
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Check every signer-list transition from the recorded initial version to the current file. */
export function verifySignerHistory(root, records) {
  const current = readSignerText(root);
  if (!current) return;
  const firstCommit = readFirstCommit(root);
  const initialHash = readInitialSignerHash(root);
  let expected = initialHash;
  for (const record of records.filter((entry) => entry.type === 'signers')) {
    if (record.initialHash !== initialHash) throw new Refused('BAD_SIGNERS_BASE', 'a signer-list receipt names a different initial list; restore .pullboard/signers.initial and its signed receipts');
    if (record.firstCommit !== firstCommit || record.previousHash !== expected || sha256(record.previousSigners ?? '') !== expected) {
      throw new Refused('UNAUTHORIZED_SIGNERS_CHANGE', 'signer-list history is broken; restore the previous list or sign its change with a key it already listed');
    }
    if (!listsPrincipal(record.previousSigners, record.by)) throw new Refused('UNAUTHORIZED_SIGNERS_CHANGE', `${record.by} was not listed before the signer-list change`);
    verifySignature(record, record.previousSigners);
    if (!/^[0-9a-f]{64}$/u.test(record.hash ?? '')) throw new Refused('UNAUTHORIZED_SIGNERS_CHANGE', 'signer-list record does not name a valid new version hash');
    expected = record.hash;
  }
  if (sha256(current) !== expected) throw new Refused('UNAUTHORIZED_SIGNERS_CHANGE', 'the signer list changed without a signature from a key it already listed');
}

/** Verify signed rows and signer-list transitions when the repo has opted into SSH sign-offs. */
export function verifySignedRecords(root, records) {
  const current = readSignerText(root);
  if (!hasSignerFile(root)) {
    if (existsSync(join(root, FIRST_COMMIT_FILE))) throw new Refused('MISSING_SIGNERS', `${SIGNERS_FILE} was removed after SSH sign-offs were enabled`);
    return records;
  }
  if (!current.trim()) throw new Refused('EMPTY_SIGNERS', `${SIGNERS_FILE} is empty; restore its SSH signer list before signing or checking`);
  verifySignerHistory(root, records);
  const first = readFirstCommit(root);
  const initialHash = readInitialSignerHash(root);
  for (const record of records) {
    if (record.type === 'signers') continue;
    if (record.initialHash !== initialHash) throw new Refused('BAD_SIGNERS_BASE', 'a sign-off names a different initial signer list; restore .pullboard/signers.initial and its signed receipts');
    if (!record.signature) throw new Refused('MISSING_SIGNATURE', `${record.id ?? 'sign-off'} is unsigned after SSH signers were enabled`);
    if (record.firstCommit !== first) throw new Refused('BAD_SIGNOFF', `${record.id} was signed for a different first commit`);
    if (!listsPrincipal(current, record.by)) throw new Refused('UNLISTED_SIGNER', `${record.by} is not listed in ${SIGNERS_FILE}`);
    verifySignature(record, current);
  }
  const rows = records.filter((record) => record.type !== 'signers');
  rows.forEach((record) => verifiedRows.add(record));
  return rows;
}

/** Resolve the first commit once, refusing to guess when a shallow clone has no recorded root. */
function firstCommitFromGit(root) {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' });
  if (shallow.status !== 0) throw new Refused('NOT_A_REPO', 'signers add needs a Git repository');
  if (shallow.stdout.trim() === 'true') throw new Refused('SHALLOW_BEFORE_OPT_IN', 'run git fetch --unshallow, then pullboard spec signers add so the first commit can be recorded');
  const roots = runTool('git', ['rev-list', '--max-parents=0', '--timestamp', 'HEAD'], { cwd: root })
    .split(/\r?\n/u).filter(Boolean).map((line) => {
      const [time, hash] = line.split(' ');
      return { time: Number(time), hash };
    });
  roots.sort((a, b) => a.time - b.time || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  if (!roots.length) throw new Refused('NO_FIRST_COMMIT', 'commit the repo before running pullboard spec signers add');
  return roots[0].hash;
}

/** Add a public key to a repo, signing later changes with a key already allowed. */
export function addSigner(root, { by, key } = {}) {
  const text = readSignerText(root);
  const publicLine = publicKey(root, key);
  const principal = by || defaultPrincipal(root);
  if (!/^(?!#)[^\s,]+$/u.test(principal)) throw new Refused('BAD_SIGNER', 'use --by with one SSH principal, or set git user.email');
  const entry = `${principal} namespaces="${SIGNOFF_NAMESPACE}" ${publicLine}`;
  if (!hasSignerFile(root)) {
    const firstCommit = firstCommitFromGit(root);
    const next = `${entry}\n`;
    const folder = dirname(join(root, SIGNERS_FILE));
    mkdirSync(folder, { recursive: true });
    writeAtomic(join(root, SIGNERS_FILE), next);
    writeAtomic(join(root, FIRST_COMMIT_FILE), `${firstCommit}\n`);
    writeAtomic(join(root, INITIAL_SIGNERS_HASH_FILE), `${sha256(next)}\n`);
    return { by: principal, added: true, path: SIGNERS_FILE, initial: true };
  }
  const records = readRawRecords(root);
  verifySignedRecords(root, records);
  if (text.split(/\r?\n/u).some((line) => line === entry)) return { by: principal, added: false, path: SIGNERS_FILE, initial: false };
  const firstCommit = readFirstCommit(root);
  const next = `${text.endsWith('\n') || !text ? text : `${text}\n`}${entry}\n`;
  const record = {
    version: 1,
    type: 'signers',
    firstCommit,
    initialHash: readInitialSignerHash(root),
    previousHash: sha256(text),
    previousSigners: text,
    hash: sha256(next),
    by: principalForSigningKey(root, text),
    on: new Date().toISOString(),
  };
  record.signature = makeSignature(root, record);
  verifySignature(record, text);
  appendRecord(root, record);
  writeAtomic(join(root, SIGNERS_FILE), next);
  return { by: principal, added: true, path: SIGNERS_FILE, initial: false };
}

/** Create and validate signed row records before a caller appends any of them. */
export function signRows(root, records, requestedKey) {
  const firstCommit = readFirstCommit(root);
  const allowed = readSignerText(root);
  const initialHash = readInitialSignerHash(root);
  const signed = records.map((fields) => {
    if (!listsPrincipal(allowed, fields.by)) throw new Refused('UNLISTED_SIGNER', `${fields.by} is not listed in ${SIGNERS_FILE}`);
    const record = { version: 1, type: 'row', firstCommit, initialHash, ...fields };
    record.signature = makeSignature(root, record, requestedKey);
    verifySignature(record, allowed);
    return record;
  });
  appendRecords(root, signed);
  return signed;
}

/** Sign an exact person decision without writing a receipt into the checkout before apply. */
export function signRowDecision(root, fields, requestedKey) {
  const allowed = readSignerText(root);
  verifySignedRecords(root, readRawRecords(root));
  if (!listsPrincipal(allowed, fields.by)) throw new Refused('UNLISTED_SIGNER', `${fields.by} is not listed in ${SIGNERS_FILE}`);
  if (!fields.commit) throw new Refused('NO_SIGNING_COMMIT', 'signed approvals include the commit read; commit or check out the repo first');
  const record = { version: 1, type: 'row-decision', firstCommit: readFirstCommit(root), initialHash: readInitialSignerHash(root), ...fields };
  record.signature = makeSignature(root, record, requestedKey);
  verifySignature(record, allowed);
  return record;
}

/** Validate a board-held approval against this checkout's established SSH trust history. */
export function verifyRowDecision(root, record) {
  if (record.decision === 'approve' && hasSignerFile(root) && !record.signature) throw new Refused('MISSING_SIGNATURE', `${record.id} approval needs the person's signed sign-off; use pullboard spec approve again`);
  verifySignedRecords(root, [...readRawRecords(root), ...(record.signature ? [record] : [])]);
}

/** Use Git's exact email as the allowed-signers principal; `--by` explicitly overrides it. */
export function defaultPrincipal(root) {
  const email = gitSetting(root, 'user.email');
  if (/^(?!#)[^\s,]+$/u.test(email)) return email;
  throw new Refused('BAD_SIGNER', 'set git user.email or pass --by <principal> for the SSH identity');
}

/** Write a whole local trust file by rename, so readers never observe a partial line. */
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Read raw sign-off records without applying signer verification recursively. */
function readRawRecords(root) {
  const file = join(root, '.pullboard/signoffs.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Refused('BAD_SIGNOFFS', `.pullboard/signoffs.jsonl line ${index + 1} is not JSON`); }
  });
}

/** Append one complete signed JSON record. */
function appendRecord(root, record) {
  appendRecords(root, [record]);
}

/** Append a group of complete signed records in one write. */
function appendRecords(root, records) {
  const file = join(root, '.pullboard/signoffs.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { flag: 'a', mode: 0o600 });
}
