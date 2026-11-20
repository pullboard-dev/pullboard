/** A block is a named set of items with a tier, and newBlock refuses anything that cannot make one [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newBlock } from '../../src/logic/claims.js';
import { newBlock as frontDoorNewBlock } from '../../index.js';

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

test('items.block.front-door-export: clause 1: newBlock imported from packages/items/index.js returns the same record and the same USAGE refusals as the packages/items/src/logic/claims.js export [C7]', () => {
  assert.equal(frontDoorNewBlock, newBlock, 'the front door re-exports the one function');
  assert.deepEqual(frontDoorNewBlock('pair', [1, 2], 'light'), newBlock('pair', [1, 2], 'light'));
  const refusal = run => { try { run(); } catch (error) { return error; } return null; };
  for (const args of [['  ', [1, 2], 'light'], ['one', [1], 'light'], ['twice', [1, 1], 'light'], ['tier', [1, 2], 'heavy']]) {
    const direct = refusal(() => newBlock(...args));
    const door = refusal(() => frontDoorNewBlock(...args));
    assert.equal(door?.code, 'USAGE');
    assert.equal(door.message, direct.message);
  }
});
