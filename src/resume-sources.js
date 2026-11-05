/** Fresh, bounded Git facts for the ordinary resume card; detailed diagnostics stay explicit [N19,D1]. */
import { createHash } from 'node:crypto';
import { spawnSync } from './windows-child-process.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { CONFIG_FILE } from './config.js';
import { DOCTRINE_FILE } from './config.js';
import { LEGACY_DOCTRINE_FILE } from './config.js';
import { configFromSource } from './config.js';
import { withCommittedFiles } from './committed-file-reader.js';
import { appliedDoctrine } from './doctrine.js';
import { doctrineFromSource } from './doctrine.js';
import { loadDoctrine } from './doctrine.js';
import { agentDoctrine } from './doctrine-rulings.js';
import { cleanGitEnvironment } from './git.js';
import { headCommit } from './git.js';
import { mainSourceBlobs } from './git.js';
import { mainCheckout } from './git.js';
import { tryGit } from './git.js';
import { Refused } from './refused.js';

/** Compare actual filesystem identities without granting a guessed metadata parent project authority. */
function samePath(left, right) {
  try { return Boolean(left && right) && realpathSync.native(left) === realpathSync.native(right); }
  catch { return false; }
}

/** Read one NUL-delimited listing, so unusual path characters never become record separators. */
function worktrees(root) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', 'worktree', 'list', '--porcelain', '-z'], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the worktree facts could not be read; run pullboard resume --diagnostics');
  return result.stdout.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9),
      branch: fields.find(field => field.startsWith('branch '))?.slice(7) };
  });
}

/** Validate the primary's normal .git directory; separate metadata retains the established registry/Git fallback. */
async function primaryPath(info, listed) {
  const primary = listed[0]?.path;
  const marker = primary && join(primary, '.git');
  try {
    if (marker && statSync(marker).isDirectory() && samePath(marker, info.commonDir)) return primary;
  } catch { /* A missing or nonstandard primary must use the existing fail-closed resolver. */ }
  const { primaryCheckoutRoot } = await import('./cli.js');
  return primaryCheckoutRoot(info);
}

/** Read the same default-name alias fallback as the existing synchronous doctrine reader. */
async function doctrineSourceAt(read, commit, name) {
  let source = await read(commit, name);
  if (source === null && [DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) {
    const alias = name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE;
    const other = await read(commit, alias);
    if (other !== null) return { name: alias, source: other };
  }
  return { name, source };
}

/** Use working bytes only after their exact Git blob identities match this command's committed snapshot. */
function matchedDoctrine(ctx, primary, main, validatedPrimary) {
  const blobs = mainSourceBlobs(ctx.info.root);
  if (!blobs || blobs.commit !== main?.commit || !samePath(primary, validatedPrimary)) return null;
  try {
    const config = readFileSync(join(primary, CONFIG_FILE));
    const doctrine = readFileSync(join(primary, DOCTRINE_FILE));
    /** Git hashes the type and byte length together with the original bytes, in the repository's object format. */
    const matches = (bytes, oid) => createHash(oid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === oid;
    if (!matches(config, blobs.config) || !matches(doctrine, blobs.doctrine)) return null;
    if (configFromSource(config.toString('utf8')).practice !== DOCTRINE_FILE) return null;
    return { shared: doctrineFromSource(doctrine.toString('utf8'), DOCTRINE_FILE) };
  } catch { return null; } // Missing or unreadable working copies retain the committed Git reader and its refusals.
}

/** Read shared committed guidance and optional stale-overlay HEAD through one fresh Git child. */
async function sharedDoctrine(ctx, board, primary, main, includeHeadDoctrine, validatedPrimary) {
  if (!main?.commit) return { doctrine: agentDoctrine(ctx, board) };
  const matched = !includeHeadDoctrine && matchedDoctrine(ctx, primary, main, validatedPrimary);
  const snapshot = matched || await withCommittedFiles(ctx.info.root, async read => {
    const config = await read(main.commit, CONFIG_FILE);
    let shared = ctx.doctrine;
    if (config !== null) {
      const entry = await doctrineSourceAt(read, main.commit, configFromSource(config).practice);
      shared = doctrineFromSource(entry.source, entry.name);
    }
    let headDoctrine;
    if (includeHeadDoctrine) {
      const working = loadDoctrine(ctx.info.root, ctx.config);
      const head = headCommit(ctx.info.root);
      if (head) {
        const entry = await doctrineSourceAt(read, head, working.name);
        // The stale helper historically labels an alias read with the current working doctrine's name.
        headDoctrine = doctrineFromSource(entry.source, working.name);
      }
    }
    return { shared, headDoctrine };
  });
  const file = primary && join(primary, snapshot.shared.name);
  const current = file && existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { doctrine: appliedDoctrine(snapshot.shared, store.rowDecisions(board), current), headDoctrine: snapshot.headDoctrine };
}

/** Keep the command's verified trunk/HEAD snapshot, current branch and complete shared doctrine together. */
export async function readResumeSources(ctx, board, { compareBranch = true, includeHeadDoctrine = false } = {}) {
  const root = ctx.info.root;
  const main = mainCheckout(root);
  const listed = worktrees(root);
  const primary = await primaryPath(ctx.info, listed);
  const current = listed.find(entry => samePath(entry.path, root));
  const branch = current ? current.branch?.replace(/^refs\/heads\//u, '') ?? 'HEAD'
    : tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'HEAD';
  let ahead;
  let behind;
  if (compareBranch && main?.commit && !ctx.info.isMain) {
    const head = headCommit(root);
    const compared = head && tryGit(root, ['rev-list', '--left-right', '--count', `${main.commit}...${head}`]);
    const counts = compared?.status === 0 && /^([0-9]+)\s+([0-9]+)$/u.exec(compared.stdout);
    if (!counts) throw new Refused('NO_POLICY', 'the branch could not be compared with main; run pullboard resume --diagnostics');
    behind = Number(counts[1]); ahead = Number(counts[2]);
  }
  // Guidance follows Git's listed primary exactly as agentDoctrine does, even when placement cannot be proven.
  const guidanceRoot = listed[0]?.path;
  return { ...await sharedDoctrine(ctx, board, guidanceRoot, main, includeHeadDoctrine, primary), primary, branch, mainRef: main?.branch, ahead, behind };
}
