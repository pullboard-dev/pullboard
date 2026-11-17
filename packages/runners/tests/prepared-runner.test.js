/** Runner journey cases in one test process reuse one prepared runner, reset between cases [C7,#8262]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { preparedRunner } from './fixtures/prepared.js';
import { temporaryDirectory } from '../../store/tests/fixtures/tmp.js';
import { preparedRunnerCounts } from './fixtures/prepared.js';

test('runners.prepared-runner.two-runner-journey-cases-in-one: clause 1: two runner journey cases in one process reuse one prepared runner and see no state of the earlier case [C7,#8262]', () => {
  const first = preparedRunner(() => temporaryDirectory('prepared-runner-test-'));
  const runnerFolder = join(first.home, '.pullboard-runner');
  for (const name of ['cache/shared-cache', 'repos', 'jobs/J1', 'queue', 'recovery']) mkdirSync(join(runnerFolder, name), { recursive: true });
  writeFileSync(join(runnerFolder, 'cache/shared-cache/entry.result'), 'warm');
  writeFileSync(join(first.worker, 'left-over.txt'), 'case one');
  writeFileSync(join(first.machineHome, 'machine-state.json'), '{}');

  const second = preparedRunner(() => assert.fail('the second case prepared a second runner'));
  assert.deepEqual([second.worker, second.home, second.machineHome], [first.worker, first.home, first.machineHome], 'the second case runs in the first one\'s runner');
  assert.deepEqual(preparedRunnerCounts(), { builds: 1, uses: 2 }, 'one runner was prepared for two cases');
  assert.deepEqual(readdirSync(runnerFolder).sort(), ['cache', 'repos'], 'only the keyed caches and repos outlive a case');
  assert.ok(existsSync(join(runnerFolder, 'cache/shared-cache/entry.result')), 'the warm cache entry is still there');
  assert.deepEqual([readdirSync(second.worker), readdirSync(second.machineHome)], [[], []], 'the worker folder and machine home start empty');
});
