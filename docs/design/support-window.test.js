/** @pullboard-test-input docs/design/support-window.md */
/** @pullboard-world-pin reads the support-window design page to check its sections. */
/** The support-window design has every section the bar names and states the window and the refusal [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./support-window.md', import.meta.url), 'utf8');

test('the support-window design has every section the bar names [N26]', () => {
  for (const heading of [
    'The support window', 'The upgrade chain', 'How migrations are tested', 'Running agents and open claims',
    'Hosted boards', 'The smallest first version', 'Items building it would need', 'Open decisions for the person',
  ]) assert.match(page, new RegExp(`^## ${heading}$`, 'mu'), `missing ## ${heading}`);
});

test('the support-window design names the window, the one command and the checkpoint [N26]', () => {
  assert.match(page, /current release and one back/u);
  assert.match(page, /refused, and the refusal names one command: `pullboard upgrade`/u);
  assert.match(page, /verified, fingerprinted checkpoint/u);
  assert.match(page, /run twice safely|Run twice safely/u);
  assert.match(page, /#1499/u);
});
