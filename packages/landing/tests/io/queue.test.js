/** @pullboard-test-input packages/landing/src/io/queue.js */
/** release-queue.js is a plain ES module, so a test that imports it is cacheable and its rank capture is unchanged [C7,#3802]. */
/** @pullboard-world-pin: clauses 1 and 2 read the module's own source to prove it holds no CommonJS loader. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commonJsIn } from '../../../gate/index.js';
import { importsIn } from '../../../gate/index.js';
import { captureReleaseQueue } from '../../index.js';

const SOURCE = readFileSync(new URL('../../src/io/queue.js', import.meta.url), 'utf8');

test('clause 1: release-queue.js has no createRequire and still declines a checkout with no board [C7]', () => {
  assert.doesNotMatch(SOURCE, /createRequire/u);
  assert.equal(captureReleaseQueue(import.meta.dirname, undefined), undefined, 'an unplanned run keeps its queue position');
});

test('clause 2: the module reads as plain ES with no CommonJS edge, so tests reaching it are cacheable [C7]', () => {
  assert.ok(!commonJsIn([SOURCE])[0], "no CommonJS loader is read");
  assert.ok(!importsIn([SOURCE])[0].includes('node:module'), 'no node:module import remains');
});
