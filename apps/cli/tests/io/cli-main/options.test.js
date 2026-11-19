/** @pullboard-test-input apps/cli/src/io/cli-main/options.js */
/** @pullboard-test-input apps/cli/src/io/cli-main/run/command.js */
/** @pullboard-test-input apps/cli/src/io/commands/add.js */
/** @pullboard-test-input apps/cli/src/logic/help/work.js */
/** --level parses to values.route, and a --level that disagrees with --route refuses [C7,#10964]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandArgs } from '../../../src/io/cli-main/options.js';
import { selectedHelp } from "../../../src/io/help.js";
import { runCommand } from '../../../src/io/cli-main/run/command.js';
import { after } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

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

test('cli.io-cli-main-options.review-and-review-tier-fold: clause 1: add and edit take --review standard|strict; --review-tier still works and prints one deprecation line naming --review [C7,#10805]', async () => {
  for (const command of ['add', 'edit']) {
    assert.equal(parseCommandArgs([command, '5', '--review', 'strict']).values['review-tier'], 'strict');
    assert.equal(parseCommandArgs([command, '5', '--review', 'standard']).values['review-tier'], undefined, 'standard never lowers');
    assert.equal(parseCommandArgs([command, '5', '--review-tier', 'strict']).values['review-tier'], 'strict');
    assert.throws(() => parseCommandArgs([command, '5', '--review', 'loose']), error => error.code === 'USAGE');
  }
  assert.equal(parseCommandArgs(['show', '5', '--review']).values.review, true, 'show keeps its boolean --review');
  const seen = [];
  await runCommand(['version', '--review-tier', 'strict'], { jsonMode() {}, say() {}, result() {}, err: line => seen.push(line) });
  assert.equal(seen.length, 1, 'one line');
  assert.match(seen[0], /--review\b/);
  const quiet = [];
  await runCommand(['version', '--review', 'strict'], { jsonMode() {}, say() {}, result() {}, err: line => quiet.push(line) });
  assert.deepEqual(quiet, []);
});

test('cli.io-cli-main-options.review-key-and-help: clause 2: --json carries a review key beside review_tier, and help shows --review only [C7,#10805]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const result = JSON.parse(added.out);
  assert.equal(result.review, 'standard');
  assert.equal(result.review_tier, result.review);
  const help = selectedHelp("help", "edit", undefined, [], {}).text;
  assert.match(help, /--review standard\|strict/);
  assert.doesNotMatch(help, /--review-tier/);
});
