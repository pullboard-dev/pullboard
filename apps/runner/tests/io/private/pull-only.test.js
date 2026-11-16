/** @pullboard-test-input source-cell apps/runner */
/** @pullboard-world-pin: clause 1 reads the shipped private-check source to prove it never calls the synchronous SSH bridge. */
/** A private check on a runner is a pulled job its callers await, so #7526 can delete the dispatch bridge [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('../../../src/io/private/privacy.js', import.meta.url), 'utf8');

test('clause 1: privacy.js calls no sync runOnRunner and runs its runner work through the pull path [C7]', () => {
  assert.doesNotMatch(text, /\brunOnRunner\b(?!Async)/u, 'privacy.js names the synchronous runOnRunner');
  assert.match(text, /export async function runnerPrivateCheck/u, 'the runner private check is async');
  assert.match(text, /await runOnRunnerAsync\(/u, 'the runner work is the awaited pulled run');
});
