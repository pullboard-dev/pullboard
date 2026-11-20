import { spawnSync } from 'node:child_process';

/** Distinguishes the base worktrees one process makes. */
let counter = 0;

/** Run git in the trunk and return its stdout lines. */
function lines(root, args) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args[0]} failed: ${String(out.stderr).slice(0, 300)}`);
  return out.stdout.split('\n').filter(Boolean);
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
      const added = spawnSync('git', ['worktree', 'add', '--detach', dir, base], { cwd: root, encoding: 'utf8' });
      if (added.status !== 0) return { result: 'red' };
      try {
        return { result: verdict(await check([...sprint.testCommand, file])({ root: dir })).isGreen ? 'green' : 'red' };
      } finally {
        spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, encoding: 'utf8' });
      }
    },
    runCell: async cell => {
      const files = lines(root, ['ls-tree', '-r', '--name-only', tip, '--', `${cell}/`]).filter(file => testFile.test(file));
      if (!files.length) return { isGreen: true, files: [] };
      const run = verdict(await check([...sprint.testCommand, ...files])({ root }));
      if (run.isGreen) return run;
      const named = files.filter(file => run.output.includes(file));
      return { ...run, files: named.length ? named : files };
    },
  };
}
