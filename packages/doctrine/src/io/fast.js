/** @pullboard-module-loads packages/gate/src/io/scan.js packages/gate/src/io/assumptions.js packages/gate/src/io/catch.js packages/gate/src/io/file/size.js packages/gate/src/io/sync/spawn.js packages/gate/src/io/test/inputs.js packages/gate/src/io/test/names.js */
/**
 * The fast doctrine path for submit [C7]. A rule whose command is `node packages/gate/src/io/<path>.js`, with
 * a script marked `@file-local`, reads only the files it walks, so submit imports that check and
 * runs it in this process over the files the item changed: no runner, no source shipping, no child.
 * Counts only fall and can only rise in changed files, so those files at the merge base and at the
 * candidate decide it. One pass shares a single base checkout across every rule.
 */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitSpawnSync } from '../../../git/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** The process environment without git's repository variables, so a hook's GIT_DIR never redirects a child. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
}

const SCRIPT = /^node\s+(packages\/gate\/src\/io\/[\w./-]+\.js)$/u;

/**
 * The only checks this path may import, matching the header's load declaration [C7]. A glob over the check folder
 * put every check script, the static tree registry and through it the CLI into the selection closure of every
 * test that reaches doctrine, so a check script outside this list runs on the runner path instead.
 */
export const FAST_CHECK_SCRIPTS = Object.freeze(['packages/gate/src/io/assumptions.js', 'packages/gate/src/io/catch.js', 'packages/gate/src/io/file/size.js',
  'packages/gate/src/io/sync/spawn.js', 'packages/gate/src/io/test/inputs.js', 'packages/gate/src/io/test/names.js']);

/**
 * The checkout-relative script a rule command runs when that script is a declared fast check marked
 * `@file-local`, else null.
 *
 * @param {string} root - A checkout holding the candidate.
 * @param {string} command
 * @returns {string | null}
 */
export function fastCheckScript(root, command) {
  const script = SCRIPT.exec(command.trim())?.[1];
  if (!script || !FAST_CHECK_SCRIPTS.includes(script)) return null;
  try { return /@file-local\b/u.test(readFileSync(join(root, script), 'utf8')) ? script : null; } catch { return null; } // no script, no fast path
}

/** Split the output of one `git cat-file --batch` into blobs by name; missing names are left out. */
function parseBatch(output, names) {
  const blobs = new Map();
  let at = 0;
  for (const name of names) {
    const end = output.indexOf(0x0a, at);
    const header = output.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (header[1] !== 'blob') continue;
    const size = Number(header[2]);
    blobs.set(name, output.subarray(at, at + size));
    at += size + 1;
  }
  return blobs;
}

/**
 * One pass over the changed files: the candidate checkout is read in place and the merge base is
 * written once, with one git process, into a private directory shared by every rule.
 *
 * @param {string} root - The clean submitting checkout.
 * @returns {{ answer: (request: object) => Promise<object | null>, close: () => void }}
 */
export function createFastPass(root) {
  const bases = new Map();
  /** The directory holding the given files as committed at a revision, filling in only the ones not yet written. */
  function baseTree(revision, files) {
    let entry = bases.get(revision);
    if (!entry) { entry = { directory: mkdtempSync(join(process.env.PULLBOARD_SCRATCH || tmpdir(), 'pullboard-doctrine-files-')), have: new Set() }; bases.set(revision, entry); }
    const wanted = files.filter(file => !entry.have.has(file));
    if (wanted.length) {
      const shown = gitSpawnSync(['--no-replace-objects', 'cat-file', '--batch'], { cwd: root, env: cleanEnv(), maxBuffer: 1024 * 1024 * 1024,
        input: wanted.map(file => `${revision}:${file}\n`).join('') });
      if (shown.status !== 0) throw new Error('could not read the merge base');
      for (const [file, bytes] of parseBatch(shown.stdout, wanted)) {
        mkdirSync(dirname(join(entry.directory, file)), { recursive: true });
        writeFileSync(join(entry.directory, file), bytes);
      }
      for (const file of wanted) entry.have.add(file);
    }
    return entry.directory;
  }
  /** Run the imported check over a tree, narrowed to the files; null when the check cannot be narrowed. */
  async function narrowed(script, tree, files) {
    const scan = await import(pathToFileURL(join(root, 'packages/gate/src/io/scan.js')).href);
    const module = await import(pathToFileURL(join(root, script)).href);
    const find = Object.entries(module).find(([name, value]) => /Problems$/u.test(name) && typeof value === 'function')?.[1];
    if (typeof scan.narrowedTo !== 'function' || !find) return null;
    const started = Date.now();
    try {
      const found = scan.narrowedTo(files, () => find(tree));
      const problems = found.map(row => `${row.path}:${row.line}: ${row.text}`).sort();
      return { problems, broken: '', seconds: Math.round((Date.now() - started) / 1000), partial: true };
    } catch (error) {
      return { problems: [], broken: `could not run (${error?.code ?? error?.message ?? 'error'})`, seconds: 0, partial: true };
    }
  }
  return {
    /** Answer one hold request in-process when its rule can be narrowed; null when it cannot. */
    async answer(request) {
      const script = request.scope ? fastCheckScript(root, request.command) : null;
      if (!script || !existsSync(join(root, 'packages/gate/src/io/scan.js'))) return null;
      return narrowed(script, request.candidate ? root : baseTree(request.commit, request.scope), request.scope);
    },
    /** Remove the shared base checkouts. */
    close() { for (const { directory } of bases.values()) rmSync(directory, { recursive: true, force: true }); },
  };
}
