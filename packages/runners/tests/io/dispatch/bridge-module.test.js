/** @pullboard-test-input source-cell packages/runners */
/** @pullboard-world-pin: clause 1 reads the shipped runners sources to prove the pull path imports its helpers from bridge.js. */
/** The pull path's helpers live outside dispatch.js, so #7526 can delete the SSH transport [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as bridge from '../../../src/io/bridge.js';
import * as dispatch from '../../../src/io/dispatch.js';

const read = file => readFileSync(new URL(`../../../src/io/${file}`, import.meta.url), 'utf8');
const HELPERS = ['bridgeResult', 'MAX_OUTPUT_BYTES', 'runCeilingMs', 'runnerUnavailableRefusal', 'startupDeadline'];

test('runners.bridge-module.the-pull-path-helpers-live-in: clause 1: the pull-path helpers live in bridge.js and delegate.js and serve.js import them from there [C7]', () => {
  for (const name of HELPERS) {
    assert.match(read('bridge.js'), new RegExp(`export (?:const|function) ${name}\\b`, 'u'), `${name} is defined in bridge.js`);
    assert.doesNotMatch(read('dispatch.js'), new RegExp(`(?:const|function) ${name}\\b`, 'u'), `${name} is no longer defined in dispatch.js`);
    assert.equal(dispatch[name], bridge[name], `${name} stays reachable from dispatch.js as the same value`);
  }
  for (const file of ['pull/delegate.js', 'pull/serve.js']) {
    assert.doesNotMatch(read(file), /\b(?:bridgeResult|MAX_OUTPUT_BYTES|runCeilingMs|runnerUnavailableRefusal|startupDeadline)\b[^;\n]*from '\.\.\/dispatch\.js'/u, `${file} takes no helper from dispatch.js`);
    assert.match(read(file), /from '\.\.\/bridge\.js'/u, `${file} imports from bridge.js`);
  }
});

test('runners.bridge-module.the-moved-helpers-behave-the-same: clause 2: the moved helpers behave the same through bridge.js and the runners tests that import them pass [C7]', () => {
  assert.equal(bridge.startupDeadline({ runnerWaitDeadline: 5 }, 0), 5, 'a lease deadline with no startup budget is kept');
  assert.equal(bridge.runCeilingMs({ kind: 'main-red' }, {}), null, 'a main comparison keeps no ceiling');
  assert.equal(bridge.runCeilingMs({ kind: 'submit' }, {}), bridge.RUN_CEILING_MS, 'a submit run is bounded');
  assert.equal(bridge.MAX_OUTPUT_BYTES, 64 * 1024 ** 2, 'the output cap is unchanged');
});
