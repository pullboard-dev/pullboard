import { execFile } from 'node:child_process';
import { addWorktree } from '../../../../git/index.js';

/** Distinguishes the base worktrees one process makes. */
let counter = 0;

/** Run git in the trunk without blocking the lease timer, and answer its stdout. */
function git(root, args) {
  return new Promise((done, fail) => execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) fail(new Error(`git ${args[0]} failed: ${String(stderr).slice(0, 300)}`)); else done(stdout);
  }));
}

/** Run git in the trunk and answer its stdout lines. */
async function lines(root, args) {
  return (await git(root, args)).split('\n').filter(Boolean);
}

/** One check result as the proof reads it: green, or red with the check's own words. */
function verdict(result) {
  return result.ok ? { isGreen: true } : { isGreen: false, output: [result.detail, result.output].filter(Boolean).join('\n') };
}

/**
 * The ports the Sprint proof reads, built on the runner from the commands a land job carries in payload.sprint [C7,#12228].
 * Why: the runner has no host landing state, so the proof's static and cell runs come from the job's own argv lists and the trunk's git.
 * A cell with no test file is green and says so with files: []; a red cell names the test files its output mentions.
 * `rerunFile` runs a red file once more at the tip; `mainReceipt` runs it at base in a throwaway worktree, removed afterward, and returns { result } so a flake settles green [RFC 0011].
 *
 * @param {string} root The temp trunk the batch was staged in.
 * @param {{ base: string, tip: string, sprint: { static: string[]|null, testCommand: string[], testFiles: string }, check: (argv: string[]) => (context: { root: string }) => Promise<{ ok: boolean, detail?: string|null, output?: string }> }} job
 *   `check` is the runner's commandCheck, passed in so this file never imports job.js.
 */
export function runnerSprintPorts(root, { base, tip, sprint, check }) {
  const testFile = new RegExp(sprint.testFiles, 'u');
  return {
    changedFiles: () => lines(root, ['diff', '--no-renames', '--name-only', base, tip]),
    pin: () => tip,
    runStatic: async () => (sprint.static ? verdict(await check(sprint.static)({ root })) : { isGreen: true }),
    rerunFile: async file => verdict(await check([...sprint.testCommand, file])({ root })),
    mainReceipt: async file => {
      // Git makes the throwaway worktree beside the trunk and removes it again; no folder is created here.
      const dir = `${root}-base-${process.pid}-${(counter += 1)}`;
      try { addWorktree(root, ['--detach', dir, base]); } catch { return { result: 'red' }; }
      try {
        return { result: verdict(await check([...sprint.testCommand, file])({ root: dir })).isGreen ? 'green' : 'red' };
      } finally {
        await git(root, ['worktree', 'remove', '--force', dir]).catch(() => { /* a worktree git cannot remove stays for git worktree prune */ });
      }
    },
    runCell: async cell => {
      const files = (await lines(root, ['ls-tree', '-r', '--name-only', tip, '--', `${cell}/`])).filter(file => testFile.test(file));
      if (!files.length) return { isGreen: true, files: [] };
      const run = verdict(await check([...sprint.testCommand, ...files])({ root }));
      if (run.isGreen) return run;
      const named = files.filter(file => run.output.includes(file));
      return { ...run, files: named.length ? named : files };
    },
  };
}
