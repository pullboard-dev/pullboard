/** Collect the png files a job wrote under its screenshots directory so the receipt can carry them back [C7,#2097]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Every regular file under a folder as { path, bytes } with the path relative to the checkout; links are never followed. */
function listFiles(root, relative, rows) {
  for (const name of fs.list(join(root, relative))) {
    const path = `${relative}/${name}`;
    const info = fs.lstat(join(root, path));
    if (info.isDirectory()) listFiles(root, path, rows);
    else if (info.isFile()) rows.push({ path, bytes: info.size });
  }
  return rows;
}

/**
 * The job's screenshots as { path, bytes, sha256, base64 } rows, or a refusal naming the total when the set is over the cap.
 * Why: a refused set reads no file bytes, so a runaway screenshot folder cannot fill the worker's memory [C7].
 *
 * The runners cell's plan, cap and directory come in as `rules` from entry.js, which already imports that cell's front door,
 * so this file adds no cross-cell import.
 *
 * @param {string} checkoutRoot the checkout the job ran in
 * @param {{screenshotPlan: Function, maxBytes: number, directory: string}} rules screenshotPlan, SCREENSHOT_MAX_BYTES and SCREENSHOT_DIRECTORY
 * @returns {{screenshots: object[], refused?: {code: string, message: string}}}
 */
export function collectScreenshots(checkoutRoot, { screenshotPlan, maxBytes, directory }) {
  if (!checkoutRoot || !fs.exists(join(checkoutRoot, directory))) return { screenshots: [] };
  let plan;
  try {
    plan = screenshotPlan(listFiles(checkoutRoot, directory, []), maxBytes, directory);
  } catch (error) {
    if (error?.code !== 'SCREENSHOTS_TOO_LARGE') throw error;
    return { screenshots: [], refused: { code: error.code, message: error.message } };
  }
  const screenshots = plan.map(({ path, bytes }) => {
    const data = fs.readFile(join(checkoutRoot, path), null);
    return { path, bytes, sha256: createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') };
  });
  return { screenshots };
}
