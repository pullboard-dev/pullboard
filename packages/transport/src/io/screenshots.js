/** The controller-side writer of a runner job's screenshot files under the caller's git dir, byte for byte [C7]. */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A refusal with a stable code, kept local so this file adds no cross-cell import. */
function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/** True when a name is relative and stays inside its folder: no absolute path, no `..` step, no empty name. */
function contained(name) {
  return typeof name === 'string' && name !== '' && !isAbsolute(name) && !name.includes('\0') && !name.split(/[\\/]/u).includes('..');
}

/**
 * Write each screenshot of one runner job under `<git dir>/pullboard/screenshots/<jobId>/`.
 *
 * Why: a runner returns screenshots as base64 inside its result; the controller keeps them as files beside the job's other
 * state. The git dir comes from `git rev-parse --absolute-git-dir`, because a seat worktree's `.git` is a file.
 * Every name is checked before anything is written, so a refused call writes nothing.
 *
 * @param {string} root - A directory of the caller's repository (a main checkout or a linked worktree).
 * @param {string} jobId - The job's id; one folder name, never absolute and never climbing.
 * @param {{ path: string, base64: string }[]} screenshots - The files to write, each by a relative path.
 * @returns {Promise<string>} The folder the files were written under.
 */
export async function writeScreenshots(root, jobId, screenshots) {
  if (!contained(jobId) || /[\\/]/u.test(jobId)) throw refuse('SCREENSHOT_JOB_ID', `the job id ${JSON.stringify(jobId)} must be one relative folder name that does not climb`);
  const files = Array.isArray(screenshots) ? screenshots : [];
  for (const file of files) {
    if (!contained(file?.path)) throw refuse('SCREENSHOT_PATH', `the screenshot path ${JSON.stringify(file?.path)} must be relative and stay inside the job folder`);
    if (typeof file.base64 !== 'string') throw refuse('SCREENSHOT_BODY', `the screenshot ${file.path} has no base64 body`);
  }
  const { stdout } = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
  const folder = join(stdout.trim(), 'pullboard', 'screenshots', jobId);
  for (const file of files) {
    const target = resolve(folder, file.path);
    if (!target.startsWith(folder + sep)) throw refuse('SCREENSHOT_PATH', `the screenshot path ${file.path} leaves the job folder`);
  }
  await mkdir(folder, { recursive: true });
  for (const file of files) {
    const target = resolve(folder, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, Buffer.from(file.base64, 'base64'));
  }
  return folder;
}
