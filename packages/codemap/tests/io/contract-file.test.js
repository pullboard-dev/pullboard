/** @pullboard-test-loads packages/codemap/src/io/contracts/file.js */
/** A consumer contract file round-trips its consumer, provider and export shapes and refuses a malformed file [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import {
  readContractFile,
  writeContractFile,
} from '../../src/io/contracts/file.js';

const contract = {
  consumer: 'packages/gate',
  provider: 'packages/kernel',
  exports: [{ name: 'seal', params: ['key', 'text'], returns: 'string' }],
};

test('clause 1: writing then reading a contract file returns the same consumer, provider and export shapes [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-contract-file-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const path = join(fixture.root, 'contract.json');
  writeContractFile(path, contract);
  assert.deepEqual(readContractFile(path), contract);
});

test('clause 1: a malformed file refuses CONTRACT_MALFORMED with its next step [C7]', t => {
  const fixture = privateFixtureFiles('pullboard-contract-bad-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fixture.write('bad.json', '{"consumer": 1}');
  fixture.write('junk.json', 'not json');
  for (const file of ['bad.json', 'junk.json']) {
    assert.throws(() => readContractFile(join(fixture.root, file)), error => {
      assert.equal(error.code ?? error.rule, 'CONTRACT_MALFORMED');
      assert.match(String(error.message), /retry/u);
      return true;
    });
  }
  assert.throws(() => writeContractFile(join(fixture.root, 'x.json'), { consumer: 'a' }), /CONTRACT_MALFORMED|retry/u);
});
