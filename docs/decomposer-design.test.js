/** @pullboard-test-input docs/decomposer-design.md */
/** @pullboard-world-pin reads the decomposer design page to check that it names every step of the cut. */
/** The decomposer design page names its inputs, each step of the cut, its outputs and the person approval [D1,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./decomposer-design.md', import.meta.url), 'utf8');

test('the decomposer design names its inputs: the code map and the contracts [D1,D3]', () => {
  assert.match(page, /^## Inputs$/mu);
  assert.match(page, /\*\*The code map\.\*\*/u);
  assert.match(page, /\*\*Contracts\.\*\*/u);
});

test('the decomposer design names each step of the cut in order [D1,D3]', () => {
  const steps = ['**Parent.**', '**Contract child first.**', '**One child per cell, in parallel.**', '**Integration child last.**'];
  let at = -1;
  for (const step of steps) {
    const next = page.indexOf(step);
    assert.ok(next > at, `${step} is missing or out of order`);
    at = next;
  }
});

test('the decomposer design names its outputs and the person approval step [D1,D3]', () => {
  assert.match(page, /^## Outputs$/mu);
  assert.match(page, /Board items:/u);
  assert.match(page, /^## The person approves the cut$/mu);
  assert.match(page, /Nothing is filed until the person approves\./u);
  assert.match(page, /Nothing here is built\./u);
});
