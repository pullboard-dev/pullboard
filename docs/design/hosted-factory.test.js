/** @pullboard-test-input docs/design/hosted-factory.md */
/** @pullboard-world-pin reads the hosted-factory design page to check its sections. */
/** The hosted-factory design has every section the bar names and states no price, cost or margin [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./hosted-factory.md', import.meta.url), 'utf8');

test('the hosted-factory design has every section the bar names [N26]', () => {
  for (const heading of [
    'What a subscriber gets', 'Per-subscriber limits', 'Metering and caps', 'The smallest first version',
    'Items building it would need', 'Open decisions for the person',
  ]) assert.match(page, new RegExp(`^## ${heading}$`, 'mu'), `missing ## ${heading}`);
});

test('the hosted-factory design says a subscriber never gets a surprise bill [N26]', () => {
  assert.match(page, /never bills more/u);
  assert.match(page, /no surprise bill/u);
});

test('the hosted-factory design holds no price figure [N26]', () => {
  assert.doesNotMatch(page, /[$€£]\s?\d|\d\s?(?:USD|EUR|dollars)\b|\bper month\b/iu);
});
