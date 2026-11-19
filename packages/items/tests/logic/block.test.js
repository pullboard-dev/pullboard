/** A block is a named set of items with a tier, and newBlock refuses anything that cannot make one [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newBlock } from '../../src/logic/block.js';

test('items.block.new-block-returns-record: clause 1: newBlock(name, ids, tier) returns { name, ids, tier } for two or more distinct item ids and a tier of light, mid or strong [C7]', () => {
  assert.deepEqual(newBlock('pair', [1, 2], 'light'), { name: 'pair', ids: [1, 2], tier: 'light' });
  assert.deepEqual(newBlock('trio', [3, 4, 5], 'mid'), { name: 'trio', ids: [3, 4, 5], tier: 'mid' });
  assert.deepEqual(newBlock('big', [6, 7], 'strong'), { name: 'big', ids: [6, 7], tier: 'strong' });
});

test('items.block.new-block-refuses-usage: clause 2: newBlock refuses USAGE for a blank name, fewer than two ids, a repeated id, and a tier outside light, mid or strong [C7]', () => {
  const usage = (error) => error?.code === 'USAGE';
  assert.throws(() => newBlock('  ', [1, 2], 'light'), usage);
  assert.throws(() => newBlock(undefined, [1, 2], 'light'), usage);
  assert.throws(() => newBlock('one', [1], 'light'), usage);
  assert.throws(() => newBlock('none', [], 'light'), usage);
  assert.throws(() => newBlock('twice', [1, 1], 'light'), usage);
  assert.throws(() => newBlock('tier', [1, 2], 'heavy'), usage);
  assert.throws(() => newBlock('tier', [1, 2], undefined), usage);
});
