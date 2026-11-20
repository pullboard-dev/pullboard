/** @pullboard-world-pin: clauses 1 and 2 read the shipped gate sources to prove no gate step runs the synchronous SSH bridge. */
/** The gate's runner work all goes through the pull path, so #7526 can delete the dispatch bridge [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = file => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

test('gate.io-pull-only-callers.execution-js-and-run-tests: clause 1: execution.js and run-tests.js call no sync runOnRunner and run their runner work through the pull path [C7]', () => {
  for (const file of ['packages/gate/src/io/execution.js', 'packages/gate/src/io/run-tests.js']) {
    assert.doesNotMatch(read(file), /\brunOnRunner\b(?!Async)/u, `${file} names the synchronous runOnRunner`);
  }
  assert.match(read('packages/gate/src/io/run-tests.js'), /await runOnRunnerAsync\(/u, 'a direct test run awaits the pulled run');
  assert.match(read('packages/gate/src/io/execution.js'), /runners\.runOnRunnerAsync\(/u, 'a profiled run on a runner awaits the pulled run');
});

test('gate.io-pull-only-callers.a-runner-lease-refuses-the: clause 2: a runner lease refuses the synchronous profiled run and every full gate run is awaited [C7]', () => {
  const execution = read('packages/gate/src/io/execution.js');
  assert.match(execution, /RUNNER_RUN_SYNC/u, 'a synchronous run on a runner is refused with its next step');
  assert.doesNotMatch(execution, /\? fullGateRun\(|: fullGateRun\(/u, 'runGate no longer runs a full gate synchronously');
  assert.doesNotMatch(read('packages/gate/src/io/test/run.js'), /\bfullGateRun\(/u, 'the direct full suite awaits its gate');
  for (const file of ['packages/flakes/src/io/native.js', 'packages/flakes/src/io/native/cli.js']) {
    assert.doesNotMatch(read(file), /\brunProfiledShell\(/u, `${file} awaits its profiled runs`);
  }
});

test('gate.io-pull-only-callers.the-gate-slot-runner-service: clause 1: the gate slot runner service list drops the synchronous runOnRunner and keeps runOnRunnerAsync [C7]', () => {
  const list = read('packages/gate/src/io/slot.js').match(/const runners = \[([^\]]*)\]/u)?.[1] ?? '';
  assert.doesNotMatch(list, /'runOnRunner'/u, 'the SSH-only synchronous service is not required of a lease');
  assert.match(list, /'runOnRunnerAsync'/u, 'the pulled run stays required');
});
