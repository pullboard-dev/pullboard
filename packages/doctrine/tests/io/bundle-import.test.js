/** A verified rule bundle imports with each rule's origin and identity preserved [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { encodeBundle } from '../../src/logic/bundle/encode.js';
import { importBundle } from '../../src/io/bundle/import.js';
import { ruleIdentity } from '../../src/io/bundle/import.js';
import { signBundle } from '../../src/io/bundle/verify.js';

const make = (originBoardId, rules) => {
  const { bytes, digest } = encodeBundle({ version: 1, originBoardId, revision: 2, rules });
  const signature = signBundle(bytes, generateKeyPairSync('ed25519').privateKey);
  return { bundle: { bytes, digest, signatures: [signature] }, key: signature.key };
};

test('clause 1: a verified bundle imports its rules keyed by origin board and rule id [C7]', () => {
  const { bundle, key } = make('board-a', [{ id: 'R1', text: 'one' }, { id: 'R2', text: 'two', originBoardId: 'board-z' }]);
  const imported = importBundle(bundle, [key]);
  assert.equal(imported.digest, bundle.digest);
  assert.equal(imported.rules['board-a'].R1.text, 'one');
  assert.equal(imported.rules['board-z'].R2.text, 'two');
  assert.equal(imported.rules['board-a'].R2, undefined);
});

test('clause 1: a bundle that fails verification imports nothing [C7]', () => {
  const { bundle, key } = make('board-a', [{ id: 'R1', text: 'one' }]);
  const tampered = { ...bundle, bytes: bundle.bytes.replace('"one"', '"ONE"') };
  assert.throws(() => importBundle(tampered, [key]), error => error.code === 'BUNDLE_BYTES_CHANGED');
  assert.throws(() => importBundle({ bytes: bundle.bytes, digest: bundle.digest }, [key]), error => error.code === 'BUNDLE_UNSIGNED');
  assert.throws(() => importBundle(bundle, ['not-the-key']), error => error.code === 'BUNDLE_WRONG_ISSUER');
});

test('clause 1: origins and rule ids named like inherited properties stay own keys and pollute nothing [C7]', () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const { bundle, key } = make('constructor', names.map(id => ({ id, text: `rule ${id}` })).concat(names.map(id => ({ id: 'R1', text: `origin ${id}`, originBoardId: id }))));
  const imported = importBundle(bundle, [key]);
  for (const name of names) {
    assert.ok(Object.hasOwn(imported.rules, name), `origin ${name} is an own key`);
    assert.equal(Object.getPrototypeOf(imported.rules[name]), null, `origin ${name} keeps a prototype-free map`);
    assert.ok(Object.hasOwn(imported.rules.constructor, name), `rule id ${name} is an own key of its origin`);
    assert.equal(imported.rules.constructor[name].text, `rule ${name}`);
    assert.equal(imported.rules[name].R1.text, `origin ${name}`);
  }
  assert.equal(Object.getPrototypeOf(imported.rules), null);
  assert.deepEqual(Object.keys(imported.rules).sort(), [...names].sort(), 'every accepted origin is listed, none lost to a prototype');
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'no import replaced the shared prototype');
  assert.equal(({}).text, undefined, 'no rule field leaked onto Object.prototype');
  assert.equal(({}).R1, undefined);
});

test('clause 2: ruleIdentity is the same before and after import [C7]', () => {
  const { bundle, key } = make('board-a', [{ id: 'R1', text: 'one' }]);
  const before = { id: 'R1', text: 'one', originBoardId: 'board-a' };
  const after = importBundle(bundle, [key]).rules['board-a'].R1;
  assert.equal(ruleIdentity(after), ruleIdentity(before));
});

test('clause 2: two boards using the same rule id each keep their own identity, board and id joined, so the two differ [C7]', () => {
  const one = make('board-a', [{ id: 'R1', text: 'x' }]);
  const two = make('board-b', [{ id: 'R1', text: 'x' }]);
  const a = importBundle(one.bundle, [one.key]).rules['board-a'].R1;
  const b = importBundle(two.bundle, [two.key]).rules['board-b'].R1;
  assert.notEqual(ruleIdentity(a), ruleIdentity(b));
});
