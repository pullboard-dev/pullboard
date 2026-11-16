/** @pullboard-test-input packages/items/src/logic/edit/bar.js packages/items/src/logic/list.js packages/items/src/logic/order/work.js packages/roadmap/src/logic/milestone.js */
/** State core files read the lifecycle, engine checks and corrected bars from the pure state core [C7,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ENGINE_REGISTRY } from '../../../src/io/engine/metadata.js';
import { ENGINE_VERSION } from '../../../src/io/engine/metadata.js';
import { MILESTONE_RANK_ENGINE } from '../../../src/io/engine/metadata.js';
import { MILESTONE_RANK_ENGINE as LEAF_MILESTONE_RANK_ENGINE } from '../../../src/logic/engines/milestone-rank-engine.js';
import { MACHINE } from '../../../index.js';
import { MACHINE as CORE_MACHINE } from '../../../light.js';
import { engineAtLeast } from '../../../light.js';
import { correctedBar as coreCorrectedBar } from '../../../light.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const CORE_FILES = ['packages/items/src/logic/edit/bar.js', 'packages/items/src/logic/list.js',
  'packages/items/src/logic/order/work.js', 'packages/roadmap/src/logic/milestone.js'];

test('the four state readers import no shell module and none of the kept state shims [C7]', () => {
  for (const file of CORE_FILES) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(match => match[1]);
    assert.ok(specifiers.length, `${file} has imports to check`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /\/shell\/|src\/machine\.js$|src\/corrected-bar\.js$|src\/engine-metadata\.js$/u, `${file} imports ${specifier}`);
    }
  }
});

test('extracted engine numbers and the moved lifecycle declaration are unchanged [C7,H16]', () => {
  assert.ok(Object.values(ENGINE_REGISTRY).includes(MILESTONE_RANK_ENGINE), 'the milestone rank engine number is one the registry declares');
  assert.equal(LEAF_MILESTONE_RANK_ENGINE, MILESTONE_RANK_ENGINE, 'the leaf and the metadata name one number');
  assert.equal(ENGINE_REGISTRY['milestone-rank'], MILESTONE_RANK_ENGINE, 'discovery reads the leaf');
  assert.equal(ENGINE_VERSION, Math.max(...Object.values(ENGINE_REGISTRY)), 'the highest engine is unchanged by an older leaf');
  assert.equal(CORE_MACHINE, MACHINE, 'core and shell share one lifecycle declaration');
  assert.equal(typeof coreCorrectedBar, 'function', 'the corrected-bar reader is in the pure core');
});

test('engineAtLeast matches the engine-folder comparison for every declared engine (negative control included) [H16]', () => {
  for (const engine of Object.values(ENGINE_REGISTRY)) {
    assert.equal(engineAtLeast({}, engine), (undefined ?? ENGINE_VERSION) >= engine, `origin at engine ${engine}`);
    assert.equal(engineAtLeast({ executionEngineVersion: null }, engine), (null ?? ENGINE_VERSION) >= engine, `null at engine ${engine}`);
    for (const recorded of [1, engine - 1, engine, ENGINE_VERSION]) {
      assert.equal(engineAtLeast({ executionEngineVersion: recorded }, engine), recorded >= engine, `replay at ${recorded} for ${engine}`);
    }
  }
  assert.equal(engineAtLeast({ executionEngineVersion: MILESTONE_RANK_ENGINE - 1 }, MILESTONE_RANK_ENGINE), false, 'an older recorded move keeps the older rule');
});

test('the light door carries the readers moves, roadmap and seats use [C7]', async () => {
  const core = await import('../../../light.js');
  for (const name of ['itemHandoff', 'handoffMoveProblem', 'requireHandoffActive', 'submissionProof', 'boundedProofReason', 'submissionSize',
    'lineSettings', 'carriesImplies', 'rejectedWorkReturns', 'factFromEvent', 'submitAdmission',
    'ensureGrantActivationIndex', 'manualLandingFailureQuoted', 'canonicalMilestoneTarget']) {
    assert.equal(typeof core[name], 'function', `${name} is a light-door function`);
  }
  assert.equal(typeof core.SUBMISSION_SIZE_METHOD, 'string', 'the size method name is a light-door constant');
});
