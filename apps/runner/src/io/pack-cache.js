/** A runner keeps one packed tarball per tree id, so the same tree is packed once [C7]. */
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Pack a tree folder with npm into a destination folder and return the tarball path.
 *
 * @param {string} tree folder to pack
 * @param {string} destination folder that receives the tarball
 * @returns {string}
 */
export function npmPack(tree, destination) {
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', destination], { cwd: tree, encoding: 'utf8' });
  if (packed.error || packed.status !== 0) throw new Error(`npm pack failed: ${packed.error?.message ?? packed.stderr}`);
  return join(destination, packed.stdout.trim().split('\n').at(-1));
}

/**
 * Drop the oldest cached tarballs until the folder fits the size cap.
 * Why: the cache lives on the runner's disk for good, so size is the only thing that keeps it from growing.
 *
 * @param {string} folder
 * @param {number} maxBytes
 */
function prune(folder, maxBytes) {
  const files = readdirSync(folder).map(name => ({ name, ...statSync(join(folder, name)) }));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    rmSync(join(folder, file.name), { force: true });
    total -= file.size;
  }
}

/**
 * Build a pack function that reuses a tarball by tree id while the setting is on.
 *
 * @param {object} options
 * @param {boolean} [options.enabled] the runner.packCache setting; off packs on every call
 * @param {string} options.folder per-runner cache folder under the runner home
 * @param {number} [options.maxBytes] size cap the folder is pruned to
 * @param {(tree: string, destination: string) => string} [options.pack] packer, npm pack by default
 * @returns {(treeId: string, tree: string, destination: string) => string} the tarball path in destination
 */
export function createPackCache({ enabled = false, folder, maxBytes = DEFAULT_MAX_BYTES, pack = npmPack }) {
  return (treeId, tree, destination) => {
    if (!enabled) return pack(tree, destination);
    mkdirSync(folder, { recursive: true });
    const key = `${String(treeId).replace(/[^\w.-]/gu, '_')}.tgz`, cached = join(folder, key);
    if (!existsSync(cached)) {
      const scratch = join(folder, `.pack-${process.pid}-${Date.now()}`);
      mkdirSync(scratch, { recursive: true });
      try {
        renameSync(pack(tree, scratch), cached);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      prune(folder, maxBytes);
    }
    mkdirSync(destination, { recursive: true });
    const out = join(destination, key);
    copyFileSync(cached, out);
    return out;
  };
}
