/** Run test files with node --test in a project root, as a child that cannot reach the worker's guard or test context [C7,#11430]. */
import { runFixtureChildAsync } from './child.js';

/**
 * Run the given test files (paths under `root`) with node --test and settle to the child's result.
 * Why: the generated cell tests are meant to pass under a plain `node --test` in a project that holds the cell, not inside this runner's worker.
 */
export function runNodeTestFiles(root, files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return runFixtureChildAsync(process.execPath, ['--test', ...files], { cwd: root, env, maxBuffer: 32 * 1024 * 1024 });
}
