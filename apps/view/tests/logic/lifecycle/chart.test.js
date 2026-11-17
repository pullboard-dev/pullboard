/** Pure lifecycle labels and counts; actual native board and Chrome remain in the chart journey [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleChart } from '../../../src/logic/lifecycle/chart.js';

test('view.lifecycle-chart.clause-2-every-lifecycle-route-has-its: clause 2: every lifecycle route has its own count, plain meaning and rare-route disclosure [N26]', () => {
  const moves = new Map([
    ['open>claimed:claim', 11], ['claimed>submitted:submit', 13], ['submitted>verified:accept', 17],
    ['claimed>open:release', 2], ['claimed>open:lapse', 3], ['claimed>open:escalate', 5], ['claimed>open:refreeze', 7],
    ['submitted>open:reject', 19], ['submitted>open:reopen', 23], ['submitted>open:refreeze', 29],
    ['verified>open:reject', 31], ['verified>open:reopen', 37], ['verified>open:refreeze', 41],
    ['claimed>claimed:patch-claimed', 97], ['claimed>claimed:refreeze', 89], ['submitted>submitted:reserve', 43], ['claimed>claimed:claim', 47], ['open>open:refreeze', 53],
    ['open>open:release', 59], ['open>open:escalate', 61], ['verified>verified:accept', 67],
    ['open>verified:rehomeImport', 71], ['claimed>verified:submit-merge', 73], ['open>submitted:intake', 79], ['verified>submitted:patch', 83],
  ]);
  const items = ['open', 'open', 'claimed', 'submitted', 'verified', 'withdrawn'].map(status => ({ status }));
  const html = lifecycleChart({ items }, moves, 1);
  assert.deepEqual([...html.matchAll(/data-lifecycle-stage="([^"]+)"/gu)].map(match => match[1]), ['open', 'claimed', 'submitted', 'verified']);
  for (const words of ['11 taken', '13 submitted', '17 passed', '17 handed back', '71 sent back by a reviewer', '109 reopened after passing',
    '1 of them sent back', 'one agent each', 'a different agent checks', 'passed review', 'Withdrawn']) assert.ok(html.includes(words), words);
  for (const [n, words] of [[2, 'let go'], [7, 'check re-frozen'], [3, 'went idle'], [5, 'moved to a stronger agent'], [19, 'sent back'], [23, 'reopened'], [29, 'check re-frozen'],
    [97, 'updated while building'], [43, 'reviews started'], [47, 'claimed again while building'], [53, 'checks re-frozen while ready'], [89, 'checks re-frozen while building'], [59, 'let go while ready'], [61, 'moved to a stronger agent while ready'], [67, 'passed again']]) {
    assert.match(html, new RegExp('>' + n + '</span> ' + words), n + ' ' + words);
  }
  assert.equal((html.match(/class="edge back"/gu) || []).length, 3, 'three red dashed return routes');
  assert.match(html, /<details class="lifecycle-rare"><summary>306 rare routes<\/summary>/u, 'rare routes start closed');
  assert.doesNotMatch(html.split('</svg>')[0], /rehomeImport|submit-merge|intake|patch/u, 'rare implementation names never cross the chart');
  for (const words of ['71</span> imported with an existing review', '73</span> submitted and passed together', '79</span> brought in for review', '83</span> updated after submission']) assert.ok(html.includes(words), words);
  assert.doesNotMatch(html, /undefined|NaN/u);
});

