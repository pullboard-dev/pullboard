/** @pullboard-test-input apps/runner/src/io/controller.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const entrySource = readFileSync(new URL('../../../../runner/src/io/controller.js', import.meta.url), 'utf8');

/** Follow the literal shipped composition entry and its actual native ports, never an arbitrary child executable. */
export function runnerControllerCallees(file, body, source) {
  if (file === '../packages/runners/src/io/dispatch.js'
    && /\b(?:spawn|spawnSync)\(process\.execPath,\s*\[installation\?\.entry \?\? fileURLToPath\(new URL\('\.\.\/\.\.\/\.\.\/\.\.\/apps\/runner\/src\/io\/controller\.js', import\.meta\.url\)\),\s*'--pullboard-runner-controller'\]/u.test(body)
    && source.includes('export async function serveRunnerController(ports)')
    && entrySource.includes("import { serveRunnerController } from '../../../../packages/runners/index.js'")
    && /import\s*\{\s*privateCheckEnvelope,\s*privateCheckPhases,?\s*\}\s*from\s*['"]\.\.\/\.\.\/index\.js['"]/u.test(entrySource)
    && entrySource.includes("import { runnerItemState } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { runnerItemSources } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { controllerDeadline } from '../../../../packages/resources/index.js'")
    && entrySource.includes("import { probeRunnerJob } from '../../../../packages/runners/index.js'")
    && entrySource.includes('if (isRunnerControllerEntry()) serveRunnerController({ privateCheckEnvelope, privateCheckPhases, runnerItemState, runnerItemSources, controllerDeadline, probeRunnerJob })')) {
    return ['../packages/runners/src/io/main.js#serveRunnerController'];
  }
  return [];
}

/** Prove child-only refusals remain audited for both wrappers and item moves, without mapping other executables. */
export function assertRunnerControllerReachability({ codeProblems, codeWalk, editedSource, machine }) {
  const childGuard = editedSource('../packages/runners/src/io/dispatch.js', /^async function runInController\(root, command, options, ports\) \{$/m,
    "$&\n  if (command === 'probe') throw new Refused('RUNNER_CHILD_PROBE', 'new child-only item refusal');");
  assert.deepEqual(codeProblems(machine, childGuard).sort(), [
    'RUNNER_CHILD_PROBE is raised by accept and reject but not declared there',
    'RUNNER_CHILD_PROBE is raised by submit but not declared there',
  ]);
  const walk = codeWalk(childGuard);
  for (const entry of ['runOnRunner', 'runOnRunnerAsync']) {
    assert.ok(walk.refusalsOf(`../packages/runners/src/io/main.js#${entry}`).has('RUNNER_CHILD_PROBE'), `${entry} returns the real child refusal`);
  }
  for (const entry of ['runProfiledShell', 'runProfiledShellAsync']) {
    assert.ok(walk.refusalsOf(`../packages/gate/src/io/execution.js#${entry}`).has('RUNNER_CHILD_PROBE'), `${entry} follows its canonical runner lease port`);
  }
  const otherPort = file => ['../packages/gate/src/io/execution.js'].includes(file)
    ? childGuard(file).replaceAll('gateLease.executionServices.runners.', 'gateLease.unrelated.runners.')
    : childGuard(file);
  for (const entry of ['runProfiledShell', 'runProfiledShellAsync']) {
    assert.equal(codeWalk(otherPort).refusalsOf(`../packages/gate/src/io/execution.js#${entry}`).has('RUNNER_CHILD_PROBE'), false,
      'an unrelated property chain does not inherit a canonical runner operation');
  }
  const otherExecutable = editedSource('../packages/runners/src/io/dispatch.js', /const child = spawn\(process\.execPath, \[installation\?\.entry \?\? fileURLToPath\(new URL\('\.\.\/\.\.\/\.\.\/\.\.\/apps\/runner\/src\/io\/controller\.js', import\.meta\.url\)\), '--pullboard-runner-controller'\]/,
    "const child = spawn('unrelated-worker', [installation?.entry ?? fileURLToPath(new URL('../../../../apps/runner/src/io/controller.js', import.meta.url)), '--pullboard-runner-controller']");
  assert.equal(codeWalk(otherExecutable).refusalsOf('../packages/runners/src/io/main.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'a different executable does not inherit the private controller edge');
  const otherEntry = editedSource('../packages/runners/src/io/dispatch.js', /new URL\('\.\.\/\.\.\/\.\.\/\.\.\/apps\/runner\/src\/io\/controller\.js', import\.meta\.url\)/g,
    "new URL('../../../../apps/runner/src/io/unrelated-controller.js', import.meta.url)");
  assert.equal(codeWalk(otherEntry).refusalsOf('../packages/runners/src/io/main.js#runOnRunnerAsync').has('RUNNER_WORK_SPEC'), false,
    'an arbitrary module path does not inherit native controller policy authority');
}
