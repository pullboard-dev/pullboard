/** Explicit test-file desktop requirements, independent of Chrome command-line flags [C7,V4]. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from './windows-child-process.js';
import { explicitCheckFiles } from './browser-admission.js';

/** Only an explicit file annotation requests a GUI; --headless does not establish this capability. */
export function testsNeedGui(root, files) {
  return files.some(file => {
    try { return headerNeedsGui(readFileSync(resolve(root, file), 'utf8')); }
    catch { return false; } // Missing files retain their normal execution failure; they cannot add an inferred capability.
  });
}

/** Read annotation lines only from leading comments, stopping before any executable source or code literal. */
function headerNeedsGui(source) {
  let remaining = source.replace(/^#![^\n]*(?:\n|$)/u, '').trimStart();
  while (remaining.startsWith('/*') || remaining.startsWith('//')) {
    const block = remaining.startsWith('/*');
    const end = block ? remaining.indexOf('*/', 2) : remaining.indexOf('\n');
    if (block && end < 0) return false;
    const comment = remaining.slice(2, end < 0 ? remaining.length : end);
    if (/^[ \t]*\*?[ \t]*@pullboard-test-gui[ \t]*\r?$/mu.test(comment)) return true;
    remaining = end < 0 ? '' : remaining.slice(end + (block ? 2 : 1)).trimStart();
  }
  return false;
}

/** Read the project's tracked Node test files when an opaque full gate supplies no explicit selection. */
export function projectNeedsGui(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', 'test', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  return result.status === 0 && testsNeedGui(root, result.stdout.split('\0').filter(file => /\.test\.[cm]?js$/u.test(file)));
}

/** Classify an explicit accepted check by its selected files; opaque commands conservatively use the project's annotations. */
export async function checkNeedsGui(root, command) {
  const files = await explicitCheckFiles(root, command);
  return files ? testsNeedGui(root, files) : projectNeedsGui(root);
}
