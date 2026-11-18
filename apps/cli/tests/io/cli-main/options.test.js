/** @pullboard-test-input apps/cli/src/io/cli-main/options.js */
/** --level parses to values.route, and a --level that disagrees with --route refuses [C7,#10964]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandArgs } from '../../../src/io/cli-main/options.js';

test('cli.io-cli-main-options.level-and-route-parse-to-the-same-value: clause 1: --level light|mid|strong parses to values.route, the same value --route gives [C7,#10964]', () => {
  for (const level of ['light', 'mid', 'strong']) {
    const viaLevel = parseCommandArgs(['join', 'core', '--level', level]).values;
    const viaRoute = parseCommandArgs(['join', 'core', '--route', level]).values;
    assert.equal(viaLevel.route, level);
    assert.equal(viaLevel.route, viaRoute.route);
    assert.equal(viaLevel.level, undefined, 'readers see only values.route');
  }
  assert.equal(parseCommandArgs(['join', 'core', '--level', 'mid', '--route', 'mid']).values.route, 'mid', 'the same value twice is not a conflict');
});

test('cli.io-cli-main-options.level-and-route-with-different-values-refuse: clause 2: --level and --route with different values refuse with USAGE [C7,#10964]', () => {
  assert.throws(() => parseCommandArgs(['join', 'core', '--level', 'light', '--route', 'strong']), error => error.code === 'USAGE');
});
