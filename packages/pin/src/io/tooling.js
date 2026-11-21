/** The tooling pin: the tree of the last landing, which workers run instead of a seat's checkout [C7]. */
import { createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
import { gitExecFileSync } from '../../../git/light.js';
import { CONFIG_FILE } from '../../../kernel/browser.js';
import { Refused } from '../../../kernel/light.js';
import { treeOf } from './main.js';
import { isObjectId } from '../logic/names.js';

const fs = fileSystemAdapter();

/**
 * Locate the file that holds the pin, shared by every worktree of the repository.
 *
 * @param {string} repo - Any checkout of the repository.
 * @returns {string} The pin file path inside the common git directory.
 */
function pinFile(repo) {
  const common = gitExecFileSync(['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const dir = isAbsolute(common) ? common : resolve(repo, common);
  return join(dir, 'pullboard', 'tooling-pin.json');
}

/**
 * The secret that signs the pin file, kept beside it in the common git directory and created on first use.
 *
 * Why: only the landing writes the pin, so only a holder of this key can make a pin file the board will accept.
 *
 * @param {string} file - The pin file path.
 * @returns {string} The key as hex.
 */
function pinKey(file) {
  const keyFile = `${file}.key`;
  if (fs.exists(keyFile)) return fs.readFile(keyFile, 'utf8').trim();
  const key = randomBytes(32).toString('hex');
  try { fs.writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFile(keyFile, 'utf8').trim();
}

/** The signature over a pin's tree and commit. */
const pinSignature = (key, tree, commit) => createHmac('sha256', key).update(`PBPIN 1\n${tree}\n${commit}`).digest('hex');

/**
 * Whether this repository asks for a signed pin file: the pin.signed setting, off when the repo has no config. Read straight from the config file: the pin cell may not import the config cell.
 *
 * Why: the refusal is new, so it stays off until the landing signs every pin it writes and an upgrade signs the old one.
 *
 * @param {string} repo - Any checkout of the repository.
 * @returns {boolean}
 */
function signedPinRequired(repo) {
  try { return JSON.parse(fs.readFile(join(repo, CONFIG_FILE), 'utf8')).pin?.signed === true; } catch { return false; }
}

/**
 * Whether a pin file predates signing: it carries no signature and the board has no signing key yet.
 *
 * Why: once a key exists every pin was written signed, so an unsigned file beside a key is tampering, never an upgrade.
 *
 * @param {string} file - The pin file path.
 * @param {object} pin - The parsed pin file.
 * @returns {boolean}
 */
function isLegacyPin(file, pin) {
  return pin.signature === undefined && isObjectId(pin.commit) && !fs.exists(`${file}.key`);
}

/**
 * Sign a legacy pin file in place, once: create the key and rewrite the file atomically with its signature.
 *
 * Why: the first gate after an upgrade must run, not refuse; the file it signs is the one the old landing wrote.
 *
 * @param {string} file - The pin file path.
 * @param {{ tree: string, commit: string }} pin - The parsed legacy pin.
 * @returns {{ tree: string, commit: string }} The pin, now signed on disk.
 */
function signLegacyPin(file, pin) {
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFile(partial, `${JSON.stringify({ tree: pin.tree, commit: pin.commit, signature: pinSignature(pinKey(file), pin.tree, pin.commit) })}\n`);
  fs.rename(partial, file);
  return { tree: pin.tree, commit: pin.commit };
}

/**
 * Record the tooling pin for a landing: the tree of the landed commit.
 *
 * Why: the landing is the one moment trunk's tooling changes, so it is the one writer; the write is atomic
 * and repeating it for the same commit changes nothing.
 *
 * @param {string} repo - Any checkout of the repository.
 * @param {string} commit - The landed commit.
 * @returns {{ tree: string, commit: string }} What was written.
 */
export function writeToolingPin(repo, commit) {
  const tree = treeOf(repo, commit);
  const sha = gitExecFileSync(['-C', repo, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  const file = pinFile(repo);
  fs.mkdir(join(file, '..'), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFile(partial, `${JSON.stringify({ tree, commit: sha, signature: pinSignature(pinKey(file), tree, sha) })}\n`);
  fs.rename(partial, file);
  return { tree, commit: sha };
}

/**
 * Read the tooling pin, or null when no landing has written one yet; with pin.signed on, an unsigned or edited
 * pin file is refused.
 *
 * @param {string} repo - Any checkout of the repository.
 * @returns {{ tree: string, commit: string } | null} The pin.
 */
export function toolingPin(repo) {
  const file = pinFile(repo);
  if (!fs.exists(file)) return null;
  let pin;
  try { pin = JSON.parse(fs.readFile(file, 'utf8')); }
  catch { throw new Refused('PIN_TOOLING_CORRUPT', `The tooling pin file ${file} is unreadable; delete it and the next landing rewrites it.`); }
  if (!isObjectId(pin?.tree)) throw new Refused('PIN_TOOLING_CORRUPT', `The tooling pin file ${file} holds no tree id; delete it and the next landing rewrites it.`);
  if (!signedPinRequired(repo)) return { tree: pin.tree, commit: pin.commit };
  if (isLegacyPin(file, pin)) return signLegacyPin(file, pin);
  const expected = fs.exists(`${file}.key`) && isObjectId(pin.commit) ? pinSignature(pinKey(file), pin.tree, pin.commit) : '';
  const given = String(pin.signature ?? '');
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new Refused('PIN_TOOLING_UNSIGNED', `The tooling pin file ${file} has no valid signature, so no run uses it; delete it and the next landing rewrites it signed.`);
  }
  return { tree: pin.tree, commit: pin.commit };
}

/**
 * Choose the tooling a worker runs for a seat's commit: the pin when one exists, else the seat's own tree.
 *
 * Why: a seat on an older tree must run main's tooling, never its checkout's, so the answer does not depend
 * on which seat asks.
 *
 * @param {string} repo - Any checkout of the repository.
 * @param {string} commit - The seat's commit.
 * @returns {{ tree: string, tooling: string, pinned: boolean }} The source tree and the tooling tree.
 */
export function toolingFor(repo, commit) {
  const tree = treeOf(repo, commit);
  const pin = toolingPin(repo);
  return { tree, tooling: pin ? pin.tree : tree, pinned: pin !== null };
}
