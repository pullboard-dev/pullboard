/** Extract a tagged release without racing a short-reading tar process [C7]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const REPOSITORY = resolve(import.meta.dirname, '..');

/**
 * Archive a tag to a file, then ask tar to read that file so an early tar exit cannot break Git's pipe.
 *
 * @param {string} tag
 * @param {string} directory
 * @returns {void}
 */
export function unpackRelease(tag, directory) {
  const archive = join(dirname(directory), `${basename(directory)}-${randomUUID()}.tar`);
  try {
    const created = spawnSync('git', ['archive', `--output=${archive}`, tag], {
      cwd: REPOSITORY, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (created.status !== 0 || created.error) {
      throw new Error(`git archive ${tag} failed for ${directory}: status ${created.status}; ${created.stderr || created.error?.message || ''}`);
    }
    const extracted = spawnSync('tar', ['-x', '-f', archive, '-C', directory], { encoding: 'utf8' });
    if (extracted.status !== 0 || extracted.error) {
      throw new Error(`tar failed to unpack ${tag} into ${directory}: status ${extracted.status}; stderr: ${extracted.stderr || extracted.error?.message || ''}`);
    }
  } finally {
    rmSync(archive, { force: true });
  }
}
