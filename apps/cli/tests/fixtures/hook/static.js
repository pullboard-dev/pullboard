/** A staged static check for hook tests: one failure per staged file, naming the process that ran it [C7]. */
import { execFileSync } from 'node:child_process';

/** One `path:1: message` per staged file, so a test sees the check ran and in which process. */
export function stagedHookFailures(root) {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return staged.map(path => `${path}:1: fixture static check ran in process ${process.pid}`);
}
