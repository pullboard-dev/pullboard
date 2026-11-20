/** @pullboard-test-input source-cell gate */
/** The signing lint names a direct node:crypto key or signature call outside the signing adapter and holds today's offenders at a ceiling [C7,#11270]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  SIGNING_CEILING_FILE,
  signingLintRows,
} from '../../../src/io/adapter-lints/signing.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-signinglint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(SIGNING_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.io-adapter-lints-signing.with-the-setting-on-a-key-call: clause 1: with the setting on, a file outside the signing adapter calling node:crypto key or signature functions fails naming file, line and adapter [C7,#11270]', () => {
  const root = repo({
    'packages/a/src/x.js': "import { generateKeyPairSync, createPrivateKey, sign, verify as check } from 'node:crypto';\nconst pair = generateKeyPairSync('ed25519');\nconst key = createPrivateKey(pem);\nconst s = sign(null, data, key);\nconst ok = check(null, data, pub, s);\n",
    'packages/keys/src/io/adapter/signing.js': "import { sign } from 'node:crypto';\nconst s = sign(null, data, key);\n",
  });
  const rows = signingLintRows(root, { enabled: true });
  assert.equal(rows.length, 4);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: generateKeyPairSync\( calls node:crypto outside the signing adapter/u);
  assert.match(rows[3], /^packages\/a\/src\/x\.js:5: verify\( calls node:crypto outside the signing adapter/u);
  assert.ok(rows.every(row => row.includes('use the signing adapter in packages/keys/src/io/adapter/signing.js')));
  assert.ok(rows.every(row => !row.startsWith('packages/keys/src/io/adapter/signing.js')), 'the signing adapter is exempt');
});

test('gate.io-adapter-lints-signing.comments-tests-methods-and-strings-are: clause 1: comments, tests, methods named verify and calls named only in a string are not node:crypto calls [C7,#11270]', () => {
  const root = repo({
    'packages/a/src/x.js': "import { createHash } from 'node:crypto';\n// sign(a);\nconst h = createHash('sha256');\nconst v = token.verify(x);\n",
    'packages/a/src/y.js': "const script = `crypto.generateKeyPairSync('ed25519')`;\nconst s = sign(a);\n",
    'packages/a/tests/z.test.js': "import { sign } from 'node:crypto';\nsign(a);\n",
  });
  assert.deepEqual(signingLintRows(root, { enabled: true }), []);
});

test('gate.io-adapter-lints-signing.offenders-at-their-ceiling-pass-and: clause 2: offenders at their ceiling pass and one more call in the same file fails; the ceiling never rises [C7,#11270]', () => {
  const head = "import { sign, verify } from 'node:crypto';\n";
  const files = { 'packages/a/src/x.js': `${head}sign(a);\nverify(b);\n`, 'packages/b/src/y.js': `${head}sign(a);\n` };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = signingLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': `${head}sign(a);\nverify(b);\nsign(c);\n` }, { 'packages/a/src/x.js': 2 });
  assert.equal(signingLintRows(grown, { enabled: true }).length, 3);
});

test('gate.io-adapter-lints-signing.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, the lint reports nothing [C7,#11270]', () => {
  const root = repo({ 'packages/a/src/x.js': "import { sign } from 'node:crypto';\nsign(a);\n" });
  assert.deepEqual(signingLintRows(root), []);
  assert.deepEqual(signingLintRows(root, { enabled: false }), []);
  assert.deepEqual(signingLintRows(root, { enabled: 'yes' }), []);
});
