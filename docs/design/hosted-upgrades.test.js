/** @pullboard-test-input docs/design/hosted-upgrades.md */
/** @pullboard-world-pin reads the hosted-upgrades design page to check its sections. */
/** The hosted-upgrades design has every section the bar names and states its safety rules [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./hosted-upgrades.md', import.meta.url), 'utf8');

test('the hosted-upgrades design has every section the bar names [N26]', () => {
  for (const heading of [
    'Proving a release', 'Staged rollout and rollback', 'Board migrations', 'Running agents and open claims',
    'What the person sees', 'Items building it would need', 'Open decisions for the person',
  ]) assert.match(page, new RegExp(`^## ${heading}$`, 'mu'), `missing ## ${heading}`);
});

test('the hosted-upgrades design states the migration and rollback rules [N26]', () => {
  assert.match(page, /copies of real hosted boards/u);
  assert.match(page, /runs twice safely/u);
  assert.match(page, /never loses a row/u);
  assert.match(page, /Rollback is automatic/u);
  assert.match(page, /^Nothing\./mu);
});
