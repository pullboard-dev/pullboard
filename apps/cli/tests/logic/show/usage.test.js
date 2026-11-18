/** @pullboard-test-input apps/cli/src/logic/show/usage.js */
/** show's usage line comes from one pure function, with the exact text the full path printed before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageLine } from '../../../src/logic/show/usage.js';

const KNOWN = { inputTokens: 100, freshInputTokens: 40, cacheReadInputTokens: 50, cacheWriteInputTokens: 10, outputTokens: 20, wallMs: 3000, models: ['m1', 'm2'], unknownReasons: [], shared: false, splitByTime: false };
const UNKNOWN = { inputTokens: null, freshInputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, wallMs: 5, models: [], unknownReasons: ['no-usage', 'no-session'], shared: false, splitByTime: false };

test('cli.logic-show-usage.usage-line-matches-the-recorded-text: clause 1: usageLine returns the detail and short usage text exactly as show printed it for a known, an unknown, a shared-session and a split-by-time cost [C7]', () => {
  assert.equal(usageLine(KNOWN, { detail: true, dollars: ', $0.01' }), 'usage: input 100 (fresh 40, cached read 50, cached write 10), output 20, 3000 ms; models m1, m2, $0.01');
  assert.equal(usageLine(KNOWN, { dollars: ', $0.01' }), 'usage: input 100, output 20, $0.01; --detail');
  assert.equal(usageLine(UNKNOWN, { detail: true }), 'usage: input unknown (fresh unknown, cached read unknown, cached write unknown), output unknown, 5 ms; models unknown; unknown: no-usage, no-session');
  assert.equal(usageLine(UNKNOWN), null, 'the short form with no tokens prints no line');
  assert.equal(usageLine({ ...KNOWN, shared: true, splitByTime: true }, { detail: true }), 'usage: input 100 (fresh 40, cached read 50, cached write 10), output 20, 3000 ms; shared-session item split unknown; models m1, m2');
  assert.equal(usageLine({ ...KNOWN, splitByTime: true }), 'usage: input 100, output 20; split by time with a shared session; --detail');
});
