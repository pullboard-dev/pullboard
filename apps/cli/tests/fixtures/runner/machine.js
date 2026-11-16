/** @pullboard-test-input apps/runner/src/io/controller.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const entrySource = readFileSync(new URL('../../../../runner/src/io/controller.js', import.meta.url), 'utf8');

/** Follow the literal shipped composition entry and its actual native ports, never an arbitrary child executable. */
export function runnerControllerCallees(file, body, source) {
  if (file === '../packages/runners/src/io/dispatch.js'
    && /\b(?:spawn|spawnSync)\(process\.execPath,\s*\[installation\?\.entry \?\? runnerControllerEntry\(fileURLToPath\(new URL\('\.\.\/\.\.\/\.\.\/\.\.\/', import\.meta\.url\)\)\),\s*'--pullboard-runner-controller'\]/u.test(body)
    && source.includes('export async function serveRunnerController(ports)')
    && entrySource.includes("import { serveRunnerController } from '../../../../packages/runners/index.js'")
    && /import\s*\{\s*privateCheckEnvelope,\s*privateCheckPhases,?\s*\}\s*from\s*['"]\.\.\/\.\.\/index\.js['"]/u.test(entrySource)
    && entrySource.includes("import { runnerItemState } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { runnerItemSources } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { controllerDeadline } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { probeRunnerJob } from '../../../../packages/runners/index.js'")
    // A pulled job's short modes are served by servePullController; the bridge without a mode still serves the real controller.
    && entrySource.includes('if (isRunnerControllerEntry()) (pullMode ? servePullController(pullMode, ')
    && entrySource.includes(': serveRunnerController({ privateCheckEnvelope, privateCheckPhases, runnerItemState, runnerItemSources, controllerDeadline, probeRunnerJob }))')) {
    return ['../packages/runners/src/io/main.js#serveRunnerController'];
  }
  return [];
}

/**
 * Prove the retired SSH controller's child-only refusals are no longer part of any item move [C7].
 * Why: the controller entry now serves only pull modes (a2dd827545), so dispatch.js's runInController is unreachable from the shipped entry and a refusal planted there must stay out of the audit.
 */
export function assertRunnerControllerReachability({ codeProblems, codeWalk, editedSource, machine }) {
  const childGuard = editedSource('../packages/runners/src/io/dispatch.js', /^async function runInController\(root, command, options, ports\) \{$/m,
    "$&\n  if (command === 'probe') throw new Refused('RUNNER_CHILD_PROBE', 'new child-only item refusal');");
  assert.deepEqual(codeProblems(machine, childGuard).sort(), [], 'the retired controller child is not an item move');
  const walk = codeWalk(childGuard);
  for (const entry of ['runOnRunner', 'runOnRunnerAsync']) {
    assert.equal(walk.refusalsOf(`../packages/runners/src/io/main.js#${entry}`).has('RUNNER_CHILD_PROBE'), false, `${entry} no longer reaches the retired controller child`);
  }
  assert.equal(walk.refusalsOf('../packages/gate/src/io/execution.js#runProfiledShellAsync').has('RUNNER_CHILD_PROBE'), false, 'runProfiledShellAsync does not reach the retired controller child');
  const otherPort = file => ['../packages/gate/src/io/execution.js'].includes(file)
    ? childGuard(file).replaceAll('gateLease.executionServices.runners.', 'gateLease.unrelated.runners.')
    : childGuard(file);
  for (const entry of ['runProfiledShellAsync']) {
    assert.equal(codeWalk(otherPort).refusalsOf(`../packages/gate/src/io/execution.js#${entry}`).has('RUNNER_CHILD_PROBE'), false,
      'an unrelated property chain does not inherit a canonical runner operation');
  }
  const otherExecutable = editedSource('../packages/runners/src/io/dispatch.js', /const child = spawn\(process\.execPath, \[installation\?\.entry/,
    "const child = spawn('unrelated-worker', [installation?.entry");
  assert.equal(codeWalk(otherExecutable).refusalsOf('../packages/runners/src/io/main.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'a different executable does not inherit the private controller edge');
  const otherEntry = editedSource('../packages/runners/src/io/dispatch.js', /runnerControllerEntry\(/g, 'unrelatedEntry(');
  assert.equal(codeWalk(otherEntry).refusalsOf('../packages/runners/src/io/main.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'an arbitrary module path does not inherit native controller policy authority');
}
