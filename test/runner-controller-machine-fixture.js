import assert from 'node:assert/strict';

/** Follow the runner's literal same-file process entry; unrelated executables have no controller edge. */
export function runnerControllerCallees(file, body, source) {
  if (file === 'runners.js'
    && /\b(?:spawn|spawnSync)\(process\.execPath,\s*\[fileURLToPath\(import\.meta\.url\),\s*'--pullboard-runner-controller'\]/u.test(body)
    && source.includes('if (isRunnerControllerEntry()) serveRunnerController()')) {
    return ['runners.js#serveRunnerController'];
  }
  return [];
}

/** Prove child-only refusals remain audited for both wrappers and item moves, without mapping other executables. */
export function assertRunnerControllerReachability({ codeProblems, codeWalk, editedSource, machine }) {
  const childGuard = editedSource('runners.js', /^async function runInController\(root, command, options\) \{$/m,
    "$&\n  if (command === 'probe') throw new Refused('RUNNER_CHILD_PROBE', 'new child-only item refusal');");
  assert.deepEqual(codeProblems(machine, childGuard).sort(), [
    'RUNNER_CHILD_PROBE is raised by accept and reject but not declared there',
    'RUNNER_CHILD_PROBE is raised by submit but not declared there',
  ]);
  const walk = codeWalk(childGuard);
  for (const entry of ['runOnRunner', 'runOnRunnerAsync']) {
    assert.ok(walk.refusalsOf(`runners.js#${entry}`).has('RUNNER_CHILD_PROBE'), `${entry} returns the real child refusal`);
  }
  const otherExecutable = editedSource('runners.js', /const child = spawn\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), '--pullboard-runner-controller'\]/,
    "const child = spawn('unrelated-worker', [fileURLToPath(import.meta.url), '--pullboard-runner-controller']");
  assert.equal(codeWalk(otherExecutable).refusalsOf('runners.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'a different executable does not inherit the private controller edge');
}
