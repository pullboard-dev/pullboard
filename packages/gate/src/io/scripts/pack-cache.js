/** A runner keeps one packed tarball and one installed prefix per tree id, so the same tree is packed and installed once [C7]. */
import { execFile } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Pack a tree folder with npm into a destination folder and return the tarball path.
 *
 * @param {string} tree folder to pack
 * @param {string} destination folder that receives the tarball
 * @returns {Promise<string>} why async: a synchronous child would block a leased worker's timer
 */
export function npmPack(tree, destination) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['pack', '--silent', '--pack-destination', destination], { cwd: tree, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`npm pack failed: ${error.message}${stderr ? ` ${stderr}` : ''}`));
      else resolve(join(destination, stdout.trim().split('\n').at(-1)));
    });
  });
}

/**
 * Install a tarball into a global prefix with npm, offline, as the release test does.
 *
 * @param {string} tarball
 * @param {string} prefix folder that receives lib/node_modules and bin
 * @returns {Promise<void>} why async: a synchronous child would block a leased worker's timer
 */
export function npmInstall(tarball, prefix) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', tarball], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`npm install failed: ${error.message}${stderr ? ` ${stderr}` : ''}`));
      else resolve();
    });
  });
}

/**
 * Bytes under a path, links counted as links, so a cached install prefix measures its whole tree.
 *
 * @param {string} path
 * @returns {number}
 */
function sizeOf(path) {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

/**
 * Drop the oldest cached entries until the folder fits the size cap.
 * Why: the cache lives on the runner's disk for good, so size is the only thing that keeps it from growing.
 *
 * @param {string} folder
 * @param {number} maxBytes
 */
function prune(folder, maxBytes) {
  const files = readdirSync(folder).map(name => ({ name, mtimeMs: lstatSync(join(folder, name)).mtimeMs, size: sizeOf(join(folder, name)) }));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    rmSync(join(folder, file.name), { recursive: true, force: true });
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
 * @param {(tree: string, destination: string) => string | Promise<string>} [options.pack] packer, npm pack by default
 * @returns {(treeId: string, tree: string, destination: string) => Promise<string>} the tarball path in destination
 */
export function createPackCache({ enabled = false, folder, maxBytes = DEFAULT_MAX_BYTES, pack = npmPack }) {
  return async (treeId, tree, destination) => {
    mkdirSync(destination, { recursive: true });
    if (!enabled) return await pack(tree, destination);
    mkdirSync(folder, { recursive: true });
    const key = `${String(treeId).replace(/[^\w.-]/gu, '_')}.tgz`, cached = join(folder, key);
    if (!existsSync(cached)) {
      const scratch = join(folder, `.pack-${process.pid}-${Date.now()}`);
      mkdirSync(scratch, { recursive: true });
      try {
        renameSync(await pack(tree, scratch), cached);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      prune(folder, maxBytes);
    }
    const out = join(destination, key);
    copyFileSync(cached, out);
    return out;
  };
}

/**
 * Build an install function that reuses an installed prefix by tree id while enabled.
 * Only tests call it today, so it has no setting of its own; off, every call installs as before.
 *
 * @param {object} options
 * @param {boolean} [options.enabled] off installs on every call
 * @param {string} options.folder cache folder; one `<tree id>.prefix` folder per tree
 * @param {number} [options.maxBytes] size cap the folder is pruned to
 * @param {(tarball: string, prefix: string) => void | Promise<void>} [options.install] installer, npm install by default
 * @returns {(treeId: string, tarball: string, prefix: string) => Promise<void>} the installed prefix at prefix
 */
export function createInstallCache({ enabled = false, folder, maxBytes = DEFAULT_MAX_BYTES, install = npmInstall }) {
  return async (treeId, tarball, prefix) => {
    if (!enabled) return await install(tarball, prefix);
    mkdirSync(folder, { recursive: true });
    const cached = join(folder, `${String(treeId).replace(/[^\w.-]/gu, '_')}.prefix`);
    if (!existsSync(cached)) {
      const scratch = join(folder, `.install-${process.pid}-${Date.now()}`);
      mkdirSync(scratch, { recursive: true });
      try {
        await install(tarball, join(scratch, 'prefix'));
        renameSync(join(scratch, 'prefix'), cached);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      prune(folder, maxBytes);
    }
    mkdirSync(prefix, { recursive: true });
    cpSync(cached, prefix, { recursive: true, verbatimSymlinks: true });
  };
}
