/** @pullboard-test-input source-cell board store stats state */
/** Private native SQLite histories prove build accounting [B35,R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { buildTimeStats } from '../../../stats/index.js';
import { buildTimeLines } from '../../../stats/index.js';
import { criterionSize } from '../../../items/index.js';
import { fixture } from '../fixtures/stats/time.js';

test('landed build minutes use the last claim, ignore renewals and retain unmeasured evidence [B35,R1,R2,C7]', t => {
  const { board } = fixture(t);
  const report = buildTimeStats(store.events(board), store.listItems(board, { all: true }), [], criterionSize);
  assert.equal(report.items.find(row => row.item === 1).buildMinutes, 20);
  assert.equal(report.items.find(row => row.item === 2).buildMinutes, 15);
  assert.equal(report.items.find(row => row.item === 3).buildMinutes, null);
  assert.deepEqual(report.over15Minutes.map(row => row.item), [1]);
  assert.equal(report.over15Minutes[0].size.score, 3);
  assert.match(buildTimeLines(report).join('\n'), /#1: 20\.00 build minutes.*size 3.*exceeds 15 minutes/u);
});
