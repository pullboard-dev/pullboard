/** A test-cache part with unreadable lists never crashes the account [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { firstChangedInput } from '../../../../src/io/test/account.js';

test('gate.io-test-account-unreadable.a-test-cache-part-whose-files: clause 1: a test-cache part whose files field is not an array reads as an unknown input and never throws [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-cache-account-');
  const good = { test: 'a.test.js', files: [['a.test.js', 'x']], runner: [], inputs: [], tracked: null, options: [] };
  fixture.write('parts/old.json', JSON.stringify({ ...good, files: 'not a list' }));
  fixture.write('parts/new.json', JSON.stringify(good));
  fixture.write('parts/odd.json', JSON.stringify({ ...good, runner: {}, inputs: null }));
  const context = { node: '1' };
  const make = inputKey => ({ inputKey, context });
  assert.equal(firstChangedInput(fixture.root, make('old'), make('new')), 'unknown (earlier inputs unreadable)');
  assert.equal(firstChangedInput(fixture.root, make('new'), make('old')), 'unknown (earlier inputs unreadable)');
  assert.equal(firstChangedInput(fixture.root, make('new'), make('odd')), 'unknown (earlier inputs unreadable)');
});
