/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js packages/moves/src/io/moves/*.js */
/**
 * The lazy move registry resolves every move, its engine and its floor exactly as the eager discovery did, in the same
 * order with the same next steps, and naming one move loads only that move's own module [C7].
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
import { discoverMoves } from '../index.js';
import { lazyMoves } from '../index.js';

/** A stand-in base table of next steps, so the cell proves the merge without loading the state cell. */
const DEFAULT_NEXT_STEPS = { BASE_STEP: 'run the base step', GOOD_STEP: 'overridden by a move' };

test('clause 2: each move and its state engine resolve through the lazy registry on first use exactly as the eager registry resolved them [C7]', () => {
  const eager = discoverMoves();
  const lazy = lazyMoves();
  // First use: each operation is named before anything lists or orders the registry.
  for (const operation of eager.operations) {
    const resolved = lazy.registry[operation];
    assert.equal(resolved, lazy.registry[operation], `${operation} resolves to one declaration`);
    assert.deepEqual(resolved, eager.registry[operation], `${operation} resolves as before`);
    assert.equal(resolved.engine, eager.registry[operation].engine, `${operation} keeps engine ${eager.registry[operation].engine}`);
    assert.equal(resolved.minimumEngine, eager.registry[operation].minimumEngine, `${operation} keeps its engine floor`);
    assert.ok(Object.hasOwn(lazy.registry, operation) && operation in lazy.registry);
  }
  assert.equal(lazy.registry.noSuchMove, undefined);
  assert.equal(Object.hasOwn(lazy.registry, 'noSuchMove'), false);
  assert.ok(Array.isArray(lazy.operations));
  assert.deepEqual([...lazy.operations], [...eager.operations], 'the historical operation order is unchanged');
  assert.deepEqual(Object.keys(lazy.registry), Object.keys(eager.registry), 'the registry lists its moves in the same order');
  assert.ok(Object.isFrozen(lazy.operations));
  assert.throws(() => { 'use strict'; lazy.registry.addItem = null; }, TypeError);
  const steps = lazy.withNextSteps(DEFAULT_NEXT_STEPS);
  const expected = { ...DEFAULT_NEXT_STEPS, ...eager.nextSteps };
  assert.deepEqual(Object.keys(steps).sort(), Object.keys(expected).sort());
  for (const [code, step] of Object.entries(expected)) assert.equal(steps[code], step, `${code} keeps its next step`);
});

test('clause 2: naming one move loads only its own module, and listing the moves still refuses a broken declaration [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-lazy-moves-');
  const folder = fixture.root;
  const write = fixture.write;
  try {
    write('package.json', '{"type":"module"}\n');
    write('goodMove.js', `export default { operation: 'goodMove', engine: 7, itemIdFirstArgument: true,
  minimumEngine: () => 7, actor: () => null, nextSteps: { GOOD_STEP: 'run the good step' } };\n`);
    write('brokenMove.js', "throw new Error('brokenMove loaded');\n");
    const lazy = lazyMoves(pathToFileURL(`${folder}/`));
    assert.equal(lazy.registry.goodMove.engine, 7);
    assert.equal(lazy.registry.goodMove.minimumEngine(), 7);
    assert.ok('brokenMove' in lazy.registry, 'a move is known by its file name before it loads');
    assert.throws(() => [...lazy.operations], /brokenMove loaded/u);
    assert.throws(() => discoverMoves(pathToFileURL(`${folder}/`)), /brokenMove loaded/u);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
