/** @pullboard-test-input docs/arbiter-design.md */
/** @pullboard-world-pin reads the arbiter design page to check that every rule names its item. */
/** The arbiter design page lists every right-of-way and ruling rule with its item and names what the coordinator keeps [D1,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./arbiter-design.md', import.meta.url), 'utf8');
const row = (rule, item) => new RegExp(`^\\| ${rule}[^|]*\\| ${item} \\|$`, 'mu');

test('the arbiter design covers part 1, right of way, with an item per rule [D1,D3]', () => {
  assert.match(page, /^## Part 1: right of way$/mu);
  for (const [rule, item] of [
    ['Right of way is a lease', '#1413'], ['No gridlock', '#1439'], ['Green waves', '#1440'],
    ['Quiet versus busy units', '#1441'], ['Preemption', '#1441'], ['Fairness', '#1440'],
  ]) assert.match(page, row(rule, item), `${rule} must name ${item}`);
});

test('the arbiter design covers part 2, rulings, with an item per rule [D1,D3]', () => {
  assert.match(page, /^## Part 2: rulings without the coordinator$/mu);
  for (const [rule, item] of [
    ['A rulings ledger', '#1444'], ['The owner of a call is computed', '#1444'],
    ['Typed requests', '#1444'], ['Act and record', '#1447'],
  ]) assert.match(page, row(rule, item), `${rule} must name ${item}`);
});

test('the arbiter design names what the coordinator and the person keep [D1,D3]', () => {
  assert.match(page, /^## What the coordinator keeps$/mu);
  assert.match(page, /The coordinator keeps the exceptions/u);
  assert.match(page, /The person keeps the person decisions/u);
  assert.match(page, /Nothing here is built\./u);
});
