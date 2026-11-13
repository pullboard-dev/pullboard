/** A per-command git memo: repeated read-only git calls are answered from the first result [C7]. */
import { resolve } from 'node:path';
import { tryGit } from './main.js';

/** Read-only git calls the memo may answer from memory: the command word, plus a check that no flag makes it a write. */
const READS = {
  status: () => true,
  'ls-files': args => !args.includes('--resolve-undo'),
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
  };
}
