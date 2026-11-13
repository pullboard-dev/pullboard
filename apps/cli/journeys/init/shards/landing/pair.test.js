/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { awaitNestedRun } from '../../../../../../packages/gate/index.js';
import {
  fixture,
  scenario,
  startLandingGate,
  mergedFiles,
} from '../../../../tests/fixtures/init/shards.js';

test('two sharded landings at once on two slots each run their shards on their own slot [C7,V4]', { timeout: 170_000 }, async (t) => { // budget: two concurrent three-shard landings.
  // Two sharded landings at once on a machine with only two slots and no runner: each parent holds
  // one slot and runs its own shards on it, so neither waits forever on the other's.
  const pair = fixture({ runner: false, repoNames: ['first', 'second'] });
  t.after(() => rmSync(pair.dir, { recursive: true, force: true }));
  scenario(pair, 'green');
  const started = pair.repos.map((repo, index) => startLandingGate(pair, `concurrent landing ${index + 1}`, 120_000, repo));
  const both = [];
  let firstFailure;
  for (const terminal of started) {
    try { both.push(await awaitNestedRun(terminal)); }
    catch (error) { firstFailure ??= error; }
  }
  if (firstFailure) throw firstFailure;
  for (const landing of both) {
    assert.equal(landing.isGreen, true, landing.output);
    assert.equal(Object.keys(mergedFiles(landing.output)).length, 6);
  }
});
