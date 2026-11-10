import { execFileSync } from 'node:child_process';

/** Initialize a private fixture repository and stage exactly its intended files. */
export function stageFixtureTests(root, paths) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '--', ...paths], { cwd: root, stdio: 'ignore' });
}
