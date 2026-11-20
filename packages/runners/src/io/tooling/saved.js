/** Save a trusted tooling capture under the scratch root so a later controller process skips the rescan [C7,#8291]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { scratchRoot } from '../../../../config/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Where one root's capture at one commit and tree lives; the name is a hash, so no root text reaches a path. */
function savedPath(root, id) {
  return join(scratchRoot(), `pullboard-trusted-capture-${sha256(`${resolve(root)}\0${id.commit}\0${id.tree}`).slice(0, 32)}.json`);
}

/**
 * Write one capture beside its sha256 and the file order its inner digest needs.
 * Why: the next fleet trip is a fresh process, and re-parsing the package closure cost it 5-7 s every time.
 * Best effort: a failed save only means the next trip captures again.
 *
 * @param {string} root
 * @param {{ commit: string, tree: string }} id
 * @param {object} captured
 * @param {string[]} order The names of every file, in the order the tooling digest was taken over.
 */
export function saveTrustedCapture(root, id, captured, order) {
  try {
    const body = JSON.stringify({ version: 1, root: resolve(root), commit: id.commit, tree: id.tree, order, captured });
    const path = savedPath(root, id), staging = `${path}.${process.pid}.tmp`;
    fs.writeFile(staging, JSON.stringify({ sha256: sha256(body), body }), { mode: 0o600 });
    fs.chmod(staging, 0o600);
    fs.rename(staging, path);
  } catch { /* the capture is only slower next time */ }
}

/**
 * The saved capture for a root, commit and tree, or null when it is missing, foreign-owned, writable by others, or fails
 * any digest. Why: this is trusted-tooling code, so a saved file is never believed on its say-so: its sha256 must match,
 * and its files must re-hash to the tooling and runtime digests it claims.
 *
 * @param {string} root
 * @param {{ commit: string, tree: string }} id
 * @returns {object|null}
 */
export function loadTrustedCapture(root, id) {
  try {
    const path = savedPath(root, id), state = fs.stat(path);
    if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) return null;
    const { sha256: claimed, body } = JSON.parse(fs.readFile(path));
    if (typeof body !== 'string' || claimed !== sha256(body)) return null;
    const saved = JSON.parse(body);
    const { captured, order } = saved;
    if (saved.version !== 1 || saved.root !== resolve(root) || saved.commit !== id.commit || saved.tree !== id.tree
      || captured?.tooling?.commit !== id.commit || captured.tooling.tree !== id.tree || !Array.isArray(order)) return null;
    const { runtime, worker, tooling } = captured;
    if (runtime.sha256 !== sha256(JSON.stringify(runtime.files))) return null;
    const files = Object.fromEntries(order.map(name => [name, name === runtime.entry ? worker : runtime.files[name]]));
    if (order.some(name => typeof files[name] !== 'string') || tooling.sha256 !== sha256(JSON.stringify(files))) return null;
    return captured;
  } catch { return null; }
}
