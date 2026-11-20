/** Pure choice of which runner screenshot files come back to the caller, never reading a file or the runner [C7,#2097]. */
import { posix } from 'node:path';
import { Refused } from '../../../kernel/light.js';

/** The most the png files of one runner job may total together: 4 MiB. */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** The directory a test declares for its screenshots, relative to the job's checkout. */
export const SCREENSHOT_DIRECTORY = 'screenshots';

/**
 * The png files inside the screenshot directory, each with its size, and nothing else.
 * Why: a runner job returns only its log today, so the caller must know exactly which files to copy back; a set over
 * the byte cap is refused whole with its total named, never cut short, so a reviewer never compares a partial set [C7].
 *
 * @param {{path: string, bytes: number}[]} files the files the runner listed, as paths relative to the job checkout
 * @param {number} maxBytes the most the png files may total together
 * @param {string} [directory] the declared screenshot directory
 * @returns {{path: string, bytes: number}[]}
 */
export function screenshotPlan(files, maxBytes, directory = SCREENSHOT_DIRECTORY) {
  const plan = [];
  for (const { path, bytes } of files) {
    const clean = posix.normalize(path);
    if (clean.startsWith('../') || posix.isAbsolute(clean)) continue;
    if (posix.dirname(clean) !== posix.normalize(directory) && !clean.startsWith(`${posix.normalize(directory)}/`)) continue;
    if (!clean.endsWith('.png')) continue;
    plan.push({ path: clean, bytes });
  }
  const total = plan.reduce((sum, file) => sum + file.bytes, 0);
  if (total > maxBytes) throw new Refused('SCREENSHOTS_TOO_LARGE', `the screenshots total ${total} bytes, over the ${maxBytes} byte cap; shrink or write fewer screenshots`);
  return plan;
}
