/** A stakes raise lists the spec rows whose stakes rank rose [C7,#1084]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raisedStakesRows } from '../../src/logic/stakes.js';

test('spec.logic-stakes.raised-rows: clause 1: a stakes raise lists the rows that rose [C7,#1084]', () => {
  const before = [{ id: 'A1', stakes: 'low' }, { id: 'A2', stakes: 'team' }, { id: 'A3', stakes: 'critical' }, { id: 'A4', stakes: 'team' }, { id: 'A5', stakes: 'low' }, { id: 'A6' }, { id: 'A9', stakes: 'low' }];
  const after = [{ id: 'A1', stakes: 'critical' }, { id: 'A2', stakes: 'low' }, { id: 'A3', stakes: 'team' }, { id: 'A4', stakes: 'team' }, { id: 'A5', stakes: 'team' }, { id: 'A6', stakes: 'critical' }, { id: 'A7', stakes: 'critical' }];
  assert.deepEqual(raisedStakesRows(before, after), ['A1', 'A5', 'A6'], 'low to critical, low to team and the default team to critical rose');
  assert.deepEqual(raisedStakesRows(before, before), [], 'unchanged rows do not rise');
  assert.deepEqual(raisedStakesRows([{ id: 'A8', stakes: 'low' }], [{ id: 'B1', stakes: 'critical' }]), [], 'an added or deleted row does not rise');
});
