/** The tooling pin: the tree of the last landing, which workers run instead of a seat's checkout [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { gitExecFileSync } from '../../../git/light.js';
import { Refused } from '../../../kernel/light.js';
import { treeOf } from './main.js';
import { isObjectId } from '../logic/names.js';

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
  mkdirSync(join(file, '..'), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify({ tree, commit: sha })}\n`);
  renameSync(partial, file);
  return { tree, commit: sha };
}

/**
 * Read the tooling pin, or null when no landing has written one yet.
 *
 * @param {string} repo - Any checkout of the repository.
 * @returns {{ tree: string, commit: string } | null} The pin.
 */
export function toolingPin(repo) {
  const file = pinFile(repo);
  if (!existsSync(file)) return null;
  let pin;
  try { pin = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('PIN_TOOLING_CORRUPT', `The tooling pin file ${file} is unreadable; delete it and the next landing rewrites it.`); }
  if (!isObjectId(pin?.tree)) throw new Refused('PIN_TOOLING_CORRUPT', `The tooling pin file ${file} holds no tree id; delete it and the next landing rewrites it.`);
  return pin;
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
