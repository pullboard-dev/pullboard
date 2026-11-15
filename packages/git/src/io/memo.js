/** A per-command git memo: repeated read-only git calls are answered from the first result [C7]. */
import { resolve } from 'node:path';
import { tryGit } from './main.js';

/** Read-only git calls the memo may answer from memory: the command word, plus a check that no flag makes it a write. */
const READS = {
  status: () => true,
  'ls-files': args => !args.includes('--resolve-undo'),
  'rev-parse': () => true,
  log: args => args.includes('--first-parent'),
};

/** The git command word of an argument list, skipping `-c name=value` and other leading flags. */
function commandWord(args) {
  return args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
}

/** Run git once through the shared runner. */
function spawnGit(cwd, args) {
  return tryGit(cwd, args);
}

/**
 * Make a memoized git runner for one command to pass down.
 * Why: one submit asked git for the same status and untracked scan many times, and every ask is a process.
 * A read keyed by folder and exact arguments is answered from the first result; any other git call clears the memo.
 *
 * @param {(cwd: string, args: string[]) => { status: number, stdout: string, stderr: string }} [run] the runner to memoize (default: spawn git)
 * @returns {{ git: (cwd: string, args: string[]) => { status: number, stdout: string, stderr: string }, clear: () => void }}
 */
export function createGitMemo(run = spawnGit) {
  const answers = new Map();
  return {
    git(cwd, args) {
      const folder = resolve(cwd);
      const word = commandWord(args);
      if (!Object.hasOwn(READS, word) || !READS[word](args)) {
        answers.clear();
        return run(folder, args);
      }
      const key = JSON.stringify([folder, args]);
      if (!answers.has(key)) answers.set(key, run(folder, args));
      return answers.get(key);
    },
    clear() { answers.clear(); },
    /**
     * Resolve HEAD, HEAD^, the trunk tip and the merge base with one git process.
     * Why: `rev-parse HEAD HEAD^ trunk HEAD...trunk` prints the three tips and `^<merge base>` together, so submit's four lookups cost one spawn.
     * A repeat is answered from the memo until a git write clears it.
     *
     * @param {string} cwd the repository folder
     * @param {string} trunk the trunk ref to compare against
     * @returns {{ ok: boolean, head?: string, parent?: string, trunk?: string, mergeBase?: string, stderr?: string }}
     */
    resolveRevs(cwd, trunk) {
      const out = this.git(cwd, ['rev-parse', 'HEAD', 'HEAD^', trunk, `HEAD...${trunk}`]);
      if (out.status !== 0) return { ok: false, stderr: out.stderr };
      const lines = out.stdout.split('\n').filter(Boolean);
      const base = lines.find(line => line.startsWith('^'));
      return { ok: true, head: lines[0], parent: lines[1], trunk: lines[2], mergeBase: base ? base.slice(1) : undefined };
    },
  };
}
