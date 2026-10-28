/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const entrySource = readFileSync(new URL('../bin/runner-controller.js', import.meta.url), 'utf8');

/** Follow the literal shipped composition entry and its actual native ports, never an arbitrary child executable. */
export function runnerControllerCallees(file, body, source) {
  if (file === 'runners.js'
    && /\b(?:spawn|spawnSync)\(process\.execPath,\s*\[fileURLToPath\(new URL\('\.\.\/bin\/runner-controller\.js', import\.meta\.url\)\),\s*'--pullboard-runner-controller'\]/u.test(body)
    && source.includes('export async function serveRunnerController(ports)')
    && entrySource.includes("import { serveRunnerController } from '../src/runners.js'")
    && entrySource.includes("import { privateCheckEnvelope } from '../src/runner-private-mode.js'")
    && entrySource.includes("import { privateCheckPhases } from '../src/runner-private-mode.js'")
    && entrySource.includes('if (isRunnerControllerEntry()) serveRunnerController({ privateCheckEnvelope, privateCheckPhases })')) {
    return ['runners.js#serveRunnerController'];
  }
  return [];
}

/** Prove child-only refusals remain audited for both wrappers and item moves, without mapping other executables. */
export function assertRunnerControllerReachability({ codeProblems, codeWalk, editedSource, machine }) {
  const childGuard = editedSource('runners.js', /^async function runInController\(root, command, options, ports\) \{$/m,
    "$&\n  if (command === 'probe') throw new Refused('RUNNER_CHILD_PROBE', 'new child-only item refusal');");
  assert.deepEqual(codeProblems(machine, childGuard).sort(), [
    'RUNNER_CHILD_PROBE is raised by accept and reject but not declared there',
    'RUNNER_CHILD_PROBE is raised by submit but not declared there',
  ]);
  const walk = codeWalk(childGuard);
  for (const entry of ['runOnRunner', 'runOnRunnerAsync']) {
    assert.ok(walk.refusalsOf(`runners.js#${entry}`).has('RUNNER_CHILD_PROBE'), `${entry} returns the real child refusal`);
  }
  for (const entry of ['runProfiledShell', 'runProfiledShellAsync']) {
    assert.ok(walk.refusalsOf(`gate-execution.js#${entry}`).has('RUNNER_CHILD_PROBE'), `${entry} follows its canonical runner lease port`);
  }
  const otherPort = file => file === 'gate-execution.js'
    ? childGuard(file).replaceAll('gateLease.executionServices.runners.', 'gateLease.unrelated.runners.')
    : childGuard(file);
  for (const entry of ['runProfiledShell', 'runProfiledShellAsync']) {
    assert.equal(codeWalk(otherPort).refusalsOf(`gate-execution.js#${entry}`).has('RUNNER_CHILD_PROBE'), false,
      'an unrelated property chain does not inherit a canonical runner operation');
  }
  const otherExecutable = editedSource('runners.js', /const child = spawn\(process\.execPath, \[fileURLToPath\(new URL\('\.\.\/bin\/runner-controller\.js', import\.meta\.url\)\), '--pullboard-runner-controller'\]/,
    "const child = spawn('unrelated-worker', [fileURLToPath(new URL('../bin/runner-controller.js', import.meta.url)), '--pullboard-runner-controller']");
  assert.equal(codeWalk(otherExecutable).refusalsOf('runners.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'a different executable does not inherit the private controller edge');
  const otherEntry = editedSource('runners.js', /new URL\('\.\.\/bin\/runner-controller\.js', import\.meta\.url\)/g,
    "new URL('../bin/unrelated-controller.js', import.meta.url)");
  assert.equal(codeWalk(otherEntry).refusalsOf('runners.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'an arbitrary module path does not inherit native controller policy authority');
}
