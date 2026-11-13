/** @pullboard-test-input docs/design/hosted-instances.md */
/** @pullboard-world-pin reads the hosted-instances design page to check its sections. */
/** The hosted-instances design has every required section and stays free of prices [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./hosted-instances.md', import.meta.url), 'utf8');

test('the hosted-instances design has every section the bar names [N26]', () => {
  for (const heading of [
    'Who it is for', 'First run with no install', 'From a phone through ChatGPT and Claude', 'Hosted and local',
    'Boards and agents', 'Identity and approvals', 'What it costs to run', 'What stays private',
    'The smallest first version', 'Items building it would need', 'Open decisions for the person',
  ]) assert.match(page, new RegExp(`^## ${heading}$`, 'mu'), `missing ## ${heading}`);
});

test('the hosted-instances design names the chat connector item and passkeys [N26]', () => {
  assert.match(page, /#1494/u);
  assert.match(page, /passkey/iu);
  assert.match(page, /relay/iu);
});

test('the hosted-instances design states no price [N26]', () => {
  assert.doesNotMatch(page, /[$€£]\s?\d|\bper month\b|\bmargin\b/iu);
});
