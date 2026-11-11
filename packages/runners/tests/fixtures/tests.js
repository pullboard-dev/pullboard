import { execFileSync } from 'node:child_process';

/** Initialize a private fixture repository, stage exactly its intended files, and commit them so the runner finds a committed policy. */
export function stageFixtureTests(root, paths) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '--', ...paths], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture'],
    { cwd: root, stdio: 'ignore' });
}
