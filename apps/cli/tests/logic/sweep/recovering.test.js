/** A tools folder a stopped gate still needs survives the sweep [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepToolTrees } from '../../../../../packages/items/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** A fake repository common dir holding one stopped job whose worker died with the given refusal code. */
function stoppedJob(tools, code) {
  const common = privateFixtureFiles('pullboard-stopped-fixture-');
  common.write('pullboard/submit-handoffs/job-1/request.json', JSON.stringify({ job: 'job-1', tools }));
  common.write('pullboard/submit-handoffs/job-1/refusal.json', JSON.stringify({ code: 1, error: { code } }));
  return common;
}

test('clause 1: a gate worker dies, the tools folder is older than the limit, and a sweep before the retry keeps it [C7]', () => {
  const temp = privateFixtureFiles('pullboard-sweep-fixture-');
  const queue = privateFixtureFiles('pullboard-queue-fixture-');
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  const tools = join(temp.root, 'pullboard-handoff-tools-job-1-abc');
  const waiting = stoppedJob(tools, 'SUBMIT_HANDOFF_DEAD');
  const finished = stoppedJob(tools, 'SOME_BUILDER_RED');
  temp.write('pullboard-handoff-tools-job-1-abc/marker', 'x');
  utimesSync(tools, old, old);
  assert.deepEqual(sweepToolTrees({ temp: temp.root, queue: queue.root, commonDirs: [waiting.root] }), [], 'a job awaiting its recovery retry keeps its tools');
  assert.ok(existsSync(tools));
  assert.deepEqual(sweepToolTrees({ temp: temp.root, queue: queue.root, commonDirs: [finished.root] }), [tools], 'a job that ended for another reason owns nothing');
});
