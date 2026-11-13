/** The search index finds real reworded duplicates and near-verbatim refiles from the board, from a checked-in fixture [C7]. */
/** @pullboard-world-pin: all clauses read the checked-in duplicates fixture, never the live board. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildIndex } from '../../index.js';
import { itemText } from '../../index.js';
import { rank } from '../../index.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/duplicates.json', import.meta.url), 'utf8'));

/**
 * How many labelled pairs rank at least one of their targets in the top 3.
 * Why only earlier items: at add time the candidates are the items filed before the new one.
 *
 * @param {Record<string, number[]>} pairs - Later item id to the earlier items it restates.
 * @returns {{ found: number, missed: string[] }}
 */
function recall(pairs) {
  const byId = new Map(FIXTURE.items.map(item => [item.id, item]));
  let found = 0;
  const missed = [];
  for (const [query, targets] of Object.entries(pairs)) {
    const earlier = FIXTURE.items.filter(item => item.id < Number(query));
    const index = buildIndex(earlier.map(item => ({ id: item.id, text: itemText(item) })));
    const top = rank(index, itemText(byId.get(Number(query))), { limit: 3 }).map(hit => hit.id);
    if (targets.some(target => top.includes(target))) found += 1;
    else missed.push(`#${query} -> ${targets.map(target => `#${target}`).join('/')}; top 3 were ${top.map(id => `#${id}`).join(', ')}`);
  }
  return { found, missed };
}

test('clause 3: the fixture holds the texts of every labelled item, so the test never reads the live board [C7]', () => {
  const ids = new Set(FIXTURE.items.map(item => item.id));
  assert.equal(Object.keys(FIXTURE.reworded).length, 13);
  assert.equal(Object.keys(FIXTURE.refiles).length, 16);
  for (const [query, targets] of [...Object.entries(FIXTURE.reworded), ...Object.entries(FIXTURE.refiles)]) {
    for (const id of [Number(query), ...targets]) assert.ok(ids.has(id), `#${id} is in the fixture`);
    assert.ok(targets.every(target => target < Number(query)), `#${query} restates earlier items only`);
  }
  assert.ok(FIXTURE.items.every(item => item.title && typeof item.criterion === 'string' && typeof item.brief === 'string'));
});

test('clause 1: at least 12 of the 13 reworded duplicates rank in the top 3 [C7]', () => {
  const { found, missed } = recall(FIXTURE.reworded);
  assert.ok(found >= 12, `${found} of 13 found; missed ${missed.join('; ')}`);
});

test('clause 2: all 16 near-verbatim refiles rank in the top 3 [C7]', () => {
  const { found, missed } = recall(FIXTURE.refiles);
  assert.equal(found, 16, `missed ${missed.join('; ')}`);
});
