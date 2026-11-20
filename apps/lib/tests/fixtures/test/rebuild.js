/** Shared fixture helpers for the accepted-inventory rebuild tests: a real tooling repository, an isolated machine cache and tracked-file copies [C7]. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { temporaryDirectory } from '../../../../cli/tests/fixtures/board.js';
import { temporaryRepository } from '../../../../cli/tests/fixtures/board/submit.js';

const REPO = fileURLToPath(new URL('../../../../..', import.meta.url));

/** Isolate the machine cache for one test and restore the caller's setting; a `shared` folder outlives the test. */
export function isolateMachine(t, shared) {
  const previous = process.env.PULLBOARD_MACHINE_HOME, options = process.env.NODE_OPTIONS;
  // The runner's own preloads are foreign to the inventory fingerprint; the producer must see a plain Node.
  delete process.env.NODE_OPTIONS;
  const directory = shared ?? temporaryDirectory('accepted-identity-machine-');
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    if (options !== undefined) process.env.NODE_OPTIONS = options;
    if (!shared) rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** The checker's own tooling folders: the pinned fingerprint hashes exactly these, so a fixture needs no more to carry the pinned checker. */
export const CHECKER_PATHS = ['packages/codemap', 'packages/kernel', 'packages/git', 'packages/gate/src'];

/** List this checkout's tracked files under some paths, skipping any that are gone from the working tree. */
export function trackedFiles(...paths) {
  return execFileSync('git', ['-C', REPO, 'ls-files', '-z', ...paths], { encoding: 'utf8' }).split('\0').filter(file => file && existsSync(join(REPO, file)));
}

/** Copy tracked files from this checkout into a folder. */
export function copyFiles(root, files) {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
}

/** The relative code files a source names: import and export specifiers, dynamic imports, loaded modules and `new URL('./x', import.meta.url)`; any quoted relative path to code counts, so a lazy load is never missed. */
const REFERENCE = /['"](\.{1,2}\/[^'"\s]+\.(?:m?js|cjs))['"]|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/gu;
/** A repository folder a source names in quotes, with no extension: `'packages/state/src/logic/engines'`. */
const NAMED_FOLDER = /['"`]((?:packages|apps)\/[\w.-]+(?:\/[\w.-]+)+)['"`]/gu;
/** The producer's process entry: the files it starts from. */
const PRODUCER_ENTRY = 'apps/cli/src/io/landing/audit.js';
let runnableCache = null;

/**
 * Code and data a producer needs to run: the producer entry's import closure, every data file and command file (a loader may list a folder) and the checker folders.
 * Why not every tracked file: the producer checks the tree out twice and its census parses every file in it, so the
 * time scales with the file count; the closure is what the entry can load, and the pinned fingerprint covers only the checker folders [C7,#8125].
 */
export function runnableFiles() {
  if (runnableCache) return runnableCache;
  const tracked = new Set(trackedFiles('packages', 'apps', 'package.json').filter(file => !(file.includes('/tests/') && file.endsWith('.js'))));
  const keep = new Set(['package.json', ...trackedFiles(...CHECKER_PATHS), ...[...tracked].filter(file => !/\.(?:js|mjs|cjs)$/u.test(file))]), queue = [PRODUCER_ENTRY, ...keep, ...[...tracked].filter(file => file.startsWith('apps/cli/src/io/commands/'))];
  while (queue.length) {
    const file = queue.pop();
    keep.add(file);
    if (!/\.(?:js|mjs|cjs)$/u.test(file) || !existsSync(join(REPO, file))) continue;
    const source = readFileSync(join(REPO, file), 'utf8');
    // A source that lists folders may load whatever it finds there, so its whole folder comes along.
    // The folder reader is node's readdirSync or the file-system adapter's list(), which the cells moved listings behind (packages/fs).
    if (/readdirSync|\.list\(/u.test(source)) {
      // A folder named by a quoted path (`join(root, 'packages/state/src/logic/engines')`) is read the same way, though the closure never sees a reference to it.
      const named = [...source.matchAll(NAMED_FOLDER)].map(match => `${match[1]}/`);
      for (const sibling of tracked) {
        if (keep.has(sibling) || !(sibling.startsWith(`${dirname(file)}/`) || named.some(folder => sibling.startsWith(folder)))) continue;
        keep.add(sibling);
        queue.push(sibling);
      }
    }
    for (const match of source.matchAll(REFERENCE)) {
      const target = relative(REPO, resolve(REPO, dirname(file), match[1] ?? match[2]));
      if (tracked.has(target) && !keep.has(target)) { keep.add(target); queue.push(target); }
    }
  }
  runnableCache = [...keep].filter(file => tracked.has(file)).sort();
  return runnableCache;
}

/**
 * Build a real repository holding the checker's tooling plus a cells plan, committed on main; `runnable` adds the code a producer
 * runs from the pinned checkout.
 * Why not the whole checkout: the producer's census parses every file in this tree and cost about 95 s a case; the pinned
 * fingerprint covers only the checker folders, so the identity under test is unchanged.
 */
export function toolingRepo(t, { runnable = false } = {}) {
  const root = temporaryRepository(t, 'accepted-identity-repo-');
  copyFiles(root, [...new Set([...trackedFiles(...CHECKER_PATHS, 'package.json'), ...(runnable ? runnableFiles() : [])])]);
  writeFileSync(join(root, 'packages/codemap/data/plan/cells.json'), '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, commit: git(root, 'rev-parse', 'HEAD').trim() };
}

/** A runnable copy of this checkout's code (no tests) with one checker file changed: what a candidate that edits the gate runs. */
export function modifiedToolingCopy(t, note) {
  const copy = temporaryDirectory('accepted-identity-copy-');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  copyFiles(copy, runnableFiles());
  const checker = join(copy, 'packages/codemap/src/io/module/imports.js');
  writeFileSync(checker, `${readFileSync(checker, 'utf8')}\n// ${note}\n`);
  return copy;
}
