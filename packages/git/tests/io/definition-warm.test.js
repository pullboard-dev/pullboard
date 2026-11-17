/** @pullboard-test-input source-cell packages/git */
/** The checker fingerprint reads each file once and reuses saved edges on the next walk, measured against a cold walk [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';
import { checkCommandDefinition } from '../../src/io/check/definition.js';

test('git.definition-warm.saved-edges-faster: clause 1: a second fingerprint of a 300-module checker reads saved edges, gives the same result, and takes less time than the first [C7]', () => {
  const graph = fixtureCommittedGraph('definition-warm-');
  const count = 300;
  for (let i = 0; i < count; i++) graph.put(`m${i}.js`, i + 1 < count ? `import './m${i + 1}.js';\nexport const x${i} = ${i};\n` : 'export const last = 1;\n');
  graph.commit();
  const walk = () => {
    const start = process.hrtime.bigint();
    const result = JSON.stringify(checkCommandDefinition(graph.root, [], [`${graph.root}/m0.js`]));
    return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  };
  const cold = walk();
  const warm = walk();
  assert.equal(warm.result, cold.result, 'the saved edges give the same fingerprint');
  assert.ok(cold.result.includes('m299.js'), 'the walk followed the whole chain');
  // Recorded for the item: both walks in one process, so machine load moves them together.
  console.log(`# definition-warm: ${count} modules, cold ${cold.ms.toFixed(1)} ms, warm ${warm.ms.toFixed(1)} ms`);
  assert.ok(warm.ms < cold.ms, `the warm walk (${warm.ms} ms) is faster than the cold walk (${cold.ms} ms)`);
});
