/** The board's runner key book: a board command issues a key to a named runner and revokes it again [C7]. */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file, inside the board folder, that holds the public keys the board trusts, one per runner, and the runner names it revoked. */
export const RUNNER_KEYS_FILE = 'runner-keys.json';
const RUNNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** A refusal as a plain error carrying its rule code and next step; the command wraps it as a Refused. */
const refuse = (code, message, next) => Object.assign(new Error(message), { code, next });

/** The saved book, or an empty one when none was saved yet or the file cannot be read as JSON. */
function load(folder) {
  const path = join(folder, RUNNER_KEYS_FILE);
  if (!existsSync(path)) return { keys: [], revoked: [] };
  try {
    const book = JSON.parse(readFileSync(path, 'utf8'));
    return { keys: Array.isArray(book.keys) ? book.keys : [], revoked: Array.isArray(book.revoked) ? book.revoked : [] };
  } catch { return { keys: [], revoked: [] }; }
}

/** Replace the saved book whole by rename, so a crash never leaves half a file. */
function save(folder, book) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, RUNNER_KEYS_FILE);
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, JSON.stringify(book), { mode: 0o600 });
  renameSync(next, path);
}

/**
 * Issue a new key to a named runner: the board keeps the public half as trusted and hands back the private half once.
 *
 * Why: a key is one runner's credential, so the board makes it, names its runner and never keeps the secret half [C7].
 *
 * @param {string} folder - The board folder.
 * @param {string} runner - A plain runner name.
 * @returns {{ runner: string, publicKey: string, privateKey: string }}
 */
export function issueRunnerKey(folder, runner) {
  if (!RUNNER.test(String(runner ?? ''))) throw refuse('PULL_RUNNER_ID', 'a runner id is a plain name: letters, digits, dot, dash or underscore', 'name the runner with letters, digits, dot, dash or underscore');
  const book = load(folder);
  if (book.revoked.includes(runner)) throw refuse('PULL_RUNNER_REVOKED', `runner ${runner}'s credential was revoked and the name stays refused`, 'issue the key under a new runner name');
  if (book.keys.some(entry => entry.runner === runner)) throw refuse('PULL_KEY_EXISTS', `runner ${runner} already holds a key`, `revoke it first with pullboard runner key revoke ${runner}`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  save(folder, { ...book, keys: [...book.keys, { runner, publicKey: pub }] });
  return { runner, publicKey: pub, privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url') };
}

/**
 * Revoke a named runner's key: it stops being trusted and the name stays refused, now and after a board restart.
 *
 * @param {string} folder - The board folder.
 * @param {string} runner
 * @returns {{ revoked: boolean }} Whether the runner held a key.
 */
export function revokeRunnerKey(folder, runner) {
  const book = load(folder);
  const held = book.keys.some(entry => entry.runner === runner);
  if (!held && !book.revoked.includes(runner)) throw refuse('PULL_RUNNER_UNKNOWN', `runner ${runner} holds no key on this board`, 'pullboard runner key issue <runner> makes one');
  save(folder, { keys: book.keys.filter(entry => entry.runner !== runner), revoked: [...new Set([...book.revoked, runner])] });
  return { revoked: held };
}

/**
 * The public keys the board trusts, read fresh on every call so a revocation takes hold at once.
 *
 * @param {string} folder - The board folder.
 * @returns {string[]}
 */
export function trustedRunnerKeys(folder) {
  return load(folder).keys.map(entry => entry.publicKey);
}

/**
 * The runner names the board revoked.
 *
 * @param {string} folder - The board folder.
 * @returns {string[]}
 */
export function revokedRunnerNames(folder) {
  return load(folder).revoked;
}
