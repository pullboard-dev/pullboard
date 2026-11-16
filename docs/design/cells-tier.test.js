/** @pullboard-test-input docs/design/cells-tier.md */
/** @pullboard-world-pin reads the cells-tier design page to check its sections. */
/** The cells-tier design names the five steps, a name with alternatives, and the numbers that gate shipping [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./cells-tier.md', import.meta.url), 'utf8');

test('the cells-tier design has every section the bar names [N26]', () => {
  for (const heading of [
    'The five steps', 'The name', 'When it ships', 'The skill and the blueprint',
    'Items building it would need', 'Open decisions for the person',
  ]) assert.match(page, new RegExp(`^## ${heading}$`, 'mu'), `missing ## ${heading}`);
});

test('the cells-tier design lists measure, plan, itemize, ratchet and prove in order [N26]', () => {
  const found = [...page.matchAll(/^\d\. \*\*(\w+)\.\*\*/gmu)].map((match) => match[1]);
  assert.deepEqual(found, ['Measure', 'Plan', 'Itemize', 'Ratchet', 'Prove']);
  assert.match(page, /packages\/codemap\/src\/io\/cells\/scripts\/plan\.js/u);
  assert.match(page, /#1593/u);
  assert.match(page, /#1670/u);
});

test('the cells-tier design proposes a name with alternatives and gates shipping on our numbers [N26]', () => {
  assert.match(page, /Proposed: \*\*\w+\*\*\. Alternatives/u);
  assert.match(page, /ships only once our own restructure shows its numbers moving/u);
  assert.match(page, /338/u);
});
