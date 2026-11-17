/** @pullboard-test-loads packages/codemap/src/io/contracts/fingerprint.js */
/** A contract fingerprint covers the export and every helper it imports, and the manifest is stable [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { writeContractFile } from '../../src/io/contracts/file.js';
import {
  contractManifest,
  fingerprintExport,
} from '../../src/io/contracts/fingerprint.js';

/** Build a provider with one export that imports a helper, which imports a deeper helper, plus an unrelated file. */
function provider(prefix, t) {
  const fixture = privateFixtureFiles(prefix);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fixture.write('main.js', "import { help } from './help.js';\nexport const seal = () => help();\n");
  fixture.write('help.js', "import { deep } from './deep.js';\nexport const help = () => deep();\n");
  fixture.write('deep.js', 'export const deep = () => 1;\n');
  fixture.write('other.js', 'export const other = 1;\n');
  return fixture;
}

test('codemap.contract-fingerprint.the-fingerprint-of-an-export: clause 1: the fingerprint of an export changes when an imported helper body changes and not when an unrelated file changes [C7]', t => {
  const fixture = provider('pullboard-fingerprint-', t);
  const entry = join(fixture.root, 'main.js');
  const before = fingerprintExport(entry, 'seal');
  fixture.write('other.js', 'export const other = 2;\n');
  assert.equal(fingerprintExport(entry, 'seal'), before);
  fixture.write('deep.js', 'export const deep = () => 2;\n');
  assert.notEqual(fingerprintExport(entry, 'seal'), before);
  const afterDeep = fingerprintExport(entry, 'seal');
  fixture.write('help.js', "import { deep } from './deep.js';\nexport const help = () => deep() + 1;\n");
  assert.notEqual(fingerprintExport(entry, 'seal'), afterDeep);
  assert.notEqual(fingerprintExport(entry, 'seal'), fingerprintExport(entry, 'other'));
});

test('codemap.contract-fingerprint.the-manifest-lists-each-contract: clause 2: the manifest lists each contract with its fingerprint and is identical across two runs on the same tree [C7]', t => {
  const fixture = provider('pullboard-fingerprint-manifest-', t);
  const contract = join(fixture.root, 'contract.json');
  writeContractFile(contract, {
    consumer: 'packages/gate',
    provider: 'packages/kernel',
    exports: [{ name: 'seal', params: [], returns: 'string' }],
  });
  const sources = [{ contract, entry: join(fixture.root, 'main.js') }];
  const first = contractManifest(sources);
  assert.deepEqual(first, contractManifest(sources));
  assert.equal(first.length, 1);
  assert.equal(first[0].consumer, 'packages/gate');
  assert.deepEqual(first[0].exports, [{ name: 'seal', fingerprint: fingerprintExport(sources[0].entry, 'seal') }]);
});
