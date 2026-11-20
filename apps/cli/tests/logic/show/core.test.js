/** show's item-row lines come from one pure function, with the exact text the full path printed before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreLines } from '../../../src/logic/show/core.js';

const ITEM = { item_id: 7, item_expected_build_minutes: 30, item_criterion: '1. it works [test]', item_frozen_digest: 'abc123' };
const LINE = '#7  open  core  A title';

test('cli.logic-show-core.core-lines-match-the-recorded-text: clause 1: coreLines returns the item line, expected build, criterion, check and check digest exactly as show printed them for an item with no receipt, refusal or thread [C7]', () => {
  const lines = coreLines(ITEM, { itemLine: LINE, checkText: 'node packages/gate/src/io/run/tests.js a.test.js' });
  assert.deepEqual(lines, {
    item: '#7  open  core  A title',
    expectedBuild: 'expected build: 30 min',
    criterion: 'criterion: 1. it works [test]',
    check: ['check: node packages/gate/src/io/run/tests.js a.test.js', 'check digest: abc123'],
  });
  const bare = coreLines({ item_id: 8 }, { itemLine: LINE });
  assert.deepEqual(bare, { item: LINE, expectedBuild: null, criterion: null, check: [] }, 'an item with no bar prints only its item line');
  assert.deepEqual(coreLines({ ...ITEM, item_frozen_digest: null }, { itemLine: LINE, checkText: 'c' }).check, ['check: c'], 'no digest, no digest line');
});

const TIMING_LINE = 'check timing: exclusive gate slot; the gate runs this check alone, so runner load does not decide it';

test('cli.logic-show-core.a-timed-check-prints-its-exclusive-slot-line: clause 1: coreLines with checkTiming true adds the exclusive gate slot line after the check digest [C7]', () => {
  const lines = coreLines(ITEM, { itemLine: LINE, checkText: 'c', checkTiming: true });
  assert.deepEqual(lines.check, ['check: c', 'check digest: abc123', TIMING_LINE]);
  assert.deepEqual(coreLines({ ...ITEM, item_frozen_digest: null }, { itemLine: LINE, checkText: 'c', checkTiming: true }).check, ['check: c', TIMING_LINE], 'no digest, the line follows the check');
});

test('cli.logic-show-core.an-untimed-check-prints-today-s-lines: clause 1: coreLines with checkTiming false or absent returns exactly the lines it returns today [C7]', () => {
  const plain = coreLines(ITEM, { itemLine: LINE, checkText: 'c' });
  assert.deepEqual(coreLines(ITEM, { itemLine: LINE, checkText: 'c', checkTiming: false }), plain);
  assert.deepEqual(plain.check, ['check: c', 'check digest: abc123']);
});
