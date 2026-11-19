/** Doctor's finding for a repo whose test runner and affectedTests command cannot both run one named test file [C7]. */

const RUNNERS = ['jest', 'vitest', 'mocha'];
const PLAIN_NODE_TEST = /^node\s+--test(?:\s|$)/u;

/**
 * One problem when the package's test script names jest, vitest or mocha while affectedTests is plain node --test.
 * Why: the gate's check ran the project's runner but the proof run of the same named file ran under node --test and went red
 * on a test the project's runner passes, and nothing said the two commands disagree.
 *
 * @param {{ scripts?: { test?: string } } | null | undefined} pkg - The parsed package.json, or null when the repo has none.
 * @param {{ affectedTests?: string }} config - The board config.
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function affectedRunnerProblems(pkg, config) {
  const script = typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test : '';
  const affected = typeof config?.affectedTests === 'string' ? config.affectedTests.trim() : '';
  const runner = RUNNERS.find(name => new RegExp(`\\b${name}\\b`, 'u').test(script));
  if (!runner || !PLAIN_NODE_TEST.test(affected)) return [];
  return [{
    code: 'AFFECTED_RUNNER_MISMATCH',
    message: `the test script runs ${runner} but affectedTests is ${affected}, so a named test file runs under a different runner than the gate's check`,
    next: `set the per-file command with pullboard settings affectedTests <command that runs ${runner} on one file>`,
  }];
}
