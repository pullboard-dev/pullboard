/** Explicit test-file desktop requirements, independent of Chrome command-line flags [C7,V4]. */
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { explicitCheckFiles } from '../browser/admission.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { git } from '../../../../git/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fs = fileSystemAdapter();

/** Only an explicit file annotation requests a GUI; --headless does not establish this capability. */
export function testsNeedGui(root, files) {
  return files.some(file => {
    try { return headerNeedsGui(fs.readFile(resolve(root, file), 'utf8')); }
    catch { return false; } // Missing files retain their normal execution failure; they cannot add an inferred capability.
  });
}

/** Read one annotation tag (the GUI tag by default) only from leading comments, stopping before any executable source or code literal. */
function headerNeedsGui(source, tag = '@pullboard-test-gui') {
  let remaining = source.replace(/^#![^\n]*(?:\n|$)/u, '').trimStart();
  while (remaining.startsWith('/*') || remaining.startsWith('//')) {
    const block = remaining.startsWith('/*');
    const end = block ? remaining.indexOf('*/', 2) : remaining.indexOf('\n');
    if (block && end < 0) return false;
    const comment = remaining.slice(2, end < 0 ? remaining.length : end);
    if (new RegExp(`^[ \\t]*\\*?[ \\t]*${tag}[ \\t]*\\r?$`, 'mu').test(comment)) return true;
    remaining = end < 0 ? '' : remaining.slice(end + (block ? 2 : 1)).trimStart();
  }
  return false;
}

/** The files whose leading comments carry a @pullboard-test-timing line: each needs an exclusive runner for its timing measurements; a missing file never counts [C7]. */
export function timingTestFiles(root, files) {
  return files.filter(file => {
    try { return headerNeedsGui(fs.readFile(resolve(root, file), 'utf8'), '@pullboard-test-timing'); }
    catch { return false; }
  });
}

/** The paths a test declares it reads, one per `@pullboard-test-reads <path>` line in its leading comments; later code never counts [C7]. */
export function declaredReads(source) {
  const paths = [];
  let remaining = source.replace(/^#![^\n]*(?:\n|$)/u, '').trimStart();
  while (remaining.startsWith('/*') || remaining.startsWith('//')) {
    const block = remaining.startsWith('/*');
    const end = block ? remaining.indexOf('*/', 2) : remaining.indexOf('\n');
    if (block && end < 0) break;
    const comment = remaining.slice(2, end < 0 ? remaining.length : end);
    for (const match of comment.matchAll(/^[ \t]*\*?[ \t]*@pullboard-test-reads[ \t]+(\S+)[ \t]*\r?$/gmu)) paths.push(match[1]);
    remaining = end < 0 ? '' : remaining.slice(end + (block ? 2 : 1)).trimStart();
  }
  return paths;
}

/** The declared reads of each given test file as a Map of file to paths; a missing file declares none [C7]. */
export function readsDeclared(root, files) {
  const reads = new Map();
  for (const file of files) {
    try { reads.set(file, declaredReads(fs.readFile(resolve(root, file), 'utf8'))); }
    catch { reads.set(file, []); }
  }
  return reads;
}

/** Read the project's tracked Node test files when an opaque full gate supplies no explicit selection. */
export function projectNeedsGui(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', 'test', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  return result.status === 0 && testsNeedGui(root, result.stdout.split('\0').filter(file => /\.test\.[cm]?js$/u.test(file)));
}

/** Read immutable committed test metadata without touching the checkout or following symlinks. */
function committedGuiFiles(root, commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/iu.test(commit)) return null;
  try {
    const output = git(root, ['--no-replace-objects', 'ls-tree', '-rz', '--full-tree', commit],
      { env: cleanGitEnvironment(), maxBuffer: 64 * 1024 * 1024 });
    const entries = new Map();
    for (const record of output.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      if (tab < 0) return null;
      const [mode, type, object] = record.slice(0, tab).split(' ');
      if (!/^[a-f0-9]{40,64}$/iu.test(object ?? '')) return null;
      entries.set(record.slice(tab + 1), { mode, type, object });
    }
    return entries;
  } catch { return null; }
}

/** Unknown committed metadata must retain desktop admission rather than borrowing live source. */
function committedTestsNeedGui(root, entries, files) {
  for (const file of files) {
    const entry = entries.get(file);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return true;
    try {
      const source = git(root, ['--no-replace-objects', 'cat-file', 'blob', entry.object],
        { env: cleanGitEnvironment(), maxBuffer: 16 * 1024 * 1024 });
      if (headerNeedsGui(source)) return true;
    } catch { return true; }
  }
  return false;
}

/** Classify an explicit check from its exact committed tree when supplied, otherwise its live checkout. */
export async function checkNeedsGui(root, command, { commit, env = process.env } = {}) {
  const files = await explicitCheckFiles(root, command, { commit, env });
  if (commit !== undefined) {
    const entries = committedGuiFiles(root, commit);
    if (!entries) return true;
    const selected = files ?? [...entries.keys()].filter(file => /^(?:test|tests)\/.*\.test\.[cm]?js$/u.test(file));
    return committedTestsNeedGui(root, entries, selected);
  }
  return files ? testsNeedGui(root, files) : projectNeedsGui(root);
}
