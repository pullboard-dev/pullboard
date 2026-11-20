/** Cache the captured worker bundle by its tooling digest, so a new commit with the same tooling skips the rebuild [C7,#8462]. */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { scratchRoot } from '../../../../config/index.js';
import { LEGACY_WORKER_ENTRY } from '../../logic/entries.js';
import { WORKER_ENTRY } from '../../logic/entries.js';
import { sourceGit } from '../source/scan.js';

const fs = fileSystemAdapter();

const sha256 = text => createHash('sha256').update(text).digest('hex');
const DIGEST = /^[a-f0-9]{64}$/u;
/** Worker entries in the order workerEntry picks them; a bundle built for a later one is stale once an earlier one exists. */
const ENTRIES = ['src/runner-worker.js', LEGACY_WORKER_ENTRY, WORKER_ENTRY];

/** The hash-named bundle of one tooling digest; any root with the same tooling bytes shares it. */
function bundlePath(digest) { return join(scratchRoot(), `pullboard-tooling-bundle-${digest}.json`); }
/** The pointer naming the digest one root last built; the name is a hash, so no root text reaches a path. */
function latestPath(root) { return join(scratchRoot(), `pullboard-tooling-bundle-latest-${sha256(resolve(root)).slice(0, 32)}`); }

/** Write a file only this user can read, renamed into place whole. */
function place(path, text) {
  const staging = `${path}.${process.pid}.tmp`;
  fs.writeFile(staging, text, { mode: 0o600 });
  fs.chmod(staging, 0o600);
  fs.rename(staging, path);
}

/** A file's text when it is this user's own and no one else can write it, else null. */
function ownText(path) {
  const state = fs.stat(path);
  if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) return null;
  return fs.readFile(path, 'utf8');
}

/**
 * Save a committed capture as the bundle of its tooling digest and point this root at it.
 * Why: main moves on every landing, and a capture keyed by commit was rebuilt (export, closure parse, scan) each time
 * even when no tooling byte changed. Best effort: a failed save only means the next new commit builds again.
 *
 * @param {string} root
 * @param {object} captured
 * @param {string[]} order The names of every file, in the order the tooling digest was taken over.
 */
export function saveToolingBundle(root, captured, order) {
  try {
    const digest = captured.tooling.sha256;
    if (captured.tooling.kind !== 'git-checkout' || !DIGEST.test(digest)) return;
    const body = JSON.stringify({ version: 1, order, captured });
    place(bundlePath(digest), JSON.stringify({ sha256: sha256(body), body }));
    place(latestPath(root), digest);
  } catch { /* the bundle is only rebuilt next time */ }
}

/**
 * The bundle this root last built, re-bound to a new commit and tree, or null when it is missing, foreign-owned, fails
 * any digest, or any of its files differs at the new commit. Why each check: this is trusted-tooling code, so the cached
 * bytes are never believed on their say-so. They must re-hash to the tooling digest, and `matches` must find every file,
 * package.json included, as the exact Git blob at the new commit; with no earlier worker entry there, the closure walk
 * would read the same bytes and so select the same files, and the result equals a fresh capture of that commit.
 *
 * @param {string} root The tooling root this process captures.
 * @param {{ commit: string, tree: string }} id The commit and tree the capture must describe.
 * @param {string} gitRoot The repository holding that commit.
 * @param {(root: string, commit: string, files: object) => boolean} matches Compares files with the commit's blobs.
 * @returns {{ captured: object, order: string[] }|null}
 */
export function loadToolingBundle(root, id, gitRoot, matches) {
  try {
    const digest = ownText(latestPath(root));
    if (!digest || !DIGEST.test(digest)) return null;
    const sealed = ownText(bundlePath(digest));
    if (!sealed) return null;
    const { sha256: claimed, body } = JSON.parse(sealed);
    if (typeof body !== 'string' || claimed !== sha256(body)) return null;
    const { version, order, captured } = JSON.parse(body);
    const { runtime, worker, tooling } = captured ?? {};
    if (version !== 1 || !Array.isArray(order) || tooling?.kind !== 'git-checkout' || tooling.sha256 !== digest) return null;
    if (runtime.sha256 !== sha256(JSON.stringify(runtime.files))) return null;
    const files = Object.fromEntries(order.map(name => [name, name === runtime.entry ? worker : runtime.files[name]]));
    if (order.some(name => typeof files[name] !== 'string') || sha256(JSON.stringify(files)) !== digest) return null;
    const earlier = ENTRIES.slice(0, Math.max(0, ENTRIES.indexOf(runtime.entry)));
    if (!ENTRIES.includes(runtime.entry) || (earlier.length && sourceGit(gitRoot, ['--literal-pathspecs', 'ls-tree', '--name-only', id.commit, '--', ...earlier]))) return null;
    if (!matches(gitRoot, id.commit, files)) return null;
    return { captured: { ...captured, tooling: { ...tooling, commit: id.commit, tree: id.tree } }, order };
  } catch { return null; }
}
