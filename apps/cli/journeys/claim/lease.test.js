/** Claim file leases: a live claim holds its predicted files when claims.fileLease is on [C7,#8521,#1413]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { leaseBoard } from '../../tests/fixtures/claim/lease.js';

test('clause 1: a second claim naming a file leased by a live claim is refused naming the holder, the file and the next step when the setting is on [C7,#8521]', t => {
  const { add, claim, first, second } = leaseBoard(t, { hubs: [] });
  const held = add('Holds the page', ['web/page.html']);
  const wanted = add('Also wants the page', ['web/page.html']);
  claim(held, first);
  assert.throws(() => claim(wanted, second), error => {
    assert.equal(error.code, 'FILE_LEASED');
    assert.match(error.message, new RegExp(`#${wanted} predicts web/page\\.html, which #${held} held by ${first} leases`, 'u'), 'names the holder and the file');
    assert.match(error.next, /pullboard next/u, 'names the next step');
    return true;
  });
});

test('clause 2: a hub file named in a setting is not refused [C7,#8521]', t => {
  const { add, claim, first, second } = leaseBoard(t, { hubs: ['src/index.js'] });
  const held = add('Edits the index', ['src/index.js']);
  const wanted = add('Also edits the index', ['src/index.js']);
  claim(held, first);
  claim(wanted, second);
});

test('clause 3: the setting is off by default and claims are unchanged [C7,#8521]', t => {
  assert.equal(configFromSource('{}').claims.fileLease, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"claims":{"fileLease":true,"fileLeaseHubs":["src/index.js"]}}').claims.fileLease, true, 'a project may turn it on');
  const { add, claim, first, second } = leaseBoard(t, null);
  const held = add('Holds the page', ['web/page.html']);
  const wanted = add('Also wants the page', ['web/page.html']);
  claim(held, first);
  claim(wanted, second);
});
