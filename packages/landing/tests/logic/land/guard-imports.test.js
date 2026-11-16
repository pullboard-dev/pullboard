/** @pullboard-test-input packages/landing/src/logic/land/guard.js */
/** The landing guard reaches the browser-free setting through the config light door, so it does not pull in the config index door [C7,#8567]. */
/** @pullboard-world-pin: reads the landing guard source to prove which config door it imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../../../src/logic/land/guard.js', import.meta.url), 'utf8');

test('clause 1: the landing guard imports browserFreeChecksEnabled from the config light door and nothing from the config index door [C7]', () => {
  assert.match(SOURCE, /import \{ browserFreeChecksEnabled \} from '(?:\.\.\/)+config\/light\.js';/u);
  assert.doesNotMatch(SOURCE, /config\/index\.js/u);
});
