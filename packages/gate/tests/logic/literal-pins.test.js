/** @pullboard-test-input source-cell gate */
/** The literal-pins check refuses a test that pins an engine number, an exact count, a file hash or a frozen JSON snapshot, off an approved allowlist and only with gate.literalPins on [C7,#9385,#1376]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalPinFindings } from '../../src/io/adapter-lints/literal-pins.js';
import { literalPinRows } from '../../src/io/adapter-lints/literal-pins.js';
import { pinKindOf } from '../../src/io/adapter-lints/literal-pins.js';

const HASH = 'a'.repeat(63) + 'b';
const SHA1 = 'c'.repeat(39) + 'd';

/** One fixture test file per kind, each with the pin on line 3, and one clean file. */
const FILES = {
  'packages/x/tests/engine.test.js': "import assert from 'node:assert/strict';\n\nassert.equal(BAR_ENGINE, 54, 'retains its engine');\n",
  'packages/x/tests/count.test.js': "import assert from 'node:assert/strict';\n\nassert.equal(files.length, 12);\n",
  'packages/x/tests/hash.test.js': `import assert from 'node:assert/strict';\n\nassert.equal(sha256(text), '${HASH}');\n`,
  'apps/y/tests/snapshot.test.js': "import assert from 'node:assert/strict';\n\nassert.deepEqual(rows, JSON.parse(readFileSync(new URL('./snapshot.json', import.meta.url))));\n",
  'packages/x/tests/clean.test.js': "import assert from 'node:assert/strict';\n\nassert.equal(files.length, 3);\nassert.equal(BAR_ENGINE, registry.engineOf('bar'));\nassert.deepEqual(rows.map(row => row.id), [1, 2]);\n",
};
const rowsOf = files => Object.entries(files).map(([file, source]) => ({ file, source }));

test('gate.logic-literal-pins.with-gate-literalpins-on-each: clause 1: with gate.literalPins on, each of the four kinds of pin fails naming the line and the property to assert instead [C7,#9385]', () => {
  const found = literalPinRows(rowsOf(FILES), { enabled: true });
  assert.equal(found.length, 4, 'one row per pinned line and none for the clean file');
  const kinds = { 'packages/x/tests/engine.test.js': /engine literal; read the engine from the engine registry/u, 'packages/x/tests/count.test.js': /count literal; assert that every file or case/u,
    'packages/x/tests/hash.test.js': /hash literal; assert what the bytes mean/u, 'apps/y/tests/snapshot.test.js': /snapshot literal; assert the fields that matter/u };
  for (const [file, message] of Object.entries(kinds)) {
    const row = found.find(text => text.startsWith(`${file}:`));
    assert.ok(row, file);
    assert.match(row, new RegExp(`^${file.replaceAll('.', '\\.')}:3: pinned `, 'u'), 'it names the line');
    assert.match(row, message);
  }
  assert.ok(!found.some(row => row.includes('clean.test.js')));
});

test('gate.logic-literal-pins.each-kind-is-told-apart: clause 1: each kind is told apart at the line, and small counts, comments and non-test files are not pins [C7,#9385]', () => {
  assert.equal(pinKindOf('assert.strictEqual(AUTO_ESCALATE_ENGINE, 50);'), 'engine');
  assert.equal(pinKindOf('assert.equal(51, WITHDRAW_MILESTONE_ENGINE);'), 'engine');
  assert.equal(pinKindOf('assert.equal(cases.length, 40);'), 'count');
  assert.equal(pinKindOf('assert.equal(cases.length, 9);'), null, 'a small fixed shape is no inventory');
  assert.equal(pinKindOf('assert.equal(rows.length, 40);'), null, 'only files and cases are counted as an inventory');
  assert.equal(pinKindOf(`assert.equal(digest, '${SHA1}');`), 'hash');
  assert.equal(pinKindOf(`const commit = '${SHA1}';`), null, 'a 40-character id outside a digest assert is not a file hash');
  assert.equal(pinKindOf(`// assert.equal(BAR_ENGINE, 54); '${HASH}'`), null);
  assert.equal(pinKindOf('expect(rows).toMatchSnapshot();'), 'snapshot');
  assert.deepEqual(literalPinFindings({ 'packages/x/src/engine.js': "assert.equal(BAR_ENGINE, 54);\n", 'README.md': `'${HASH}'` }), [], 'only test files are covered');
});

test('gate.logic-literal-pins.a-file-on-the-approved: clause 2: a file on the approved-text allowlist passes for its listed kinds, and for every kind when it lists none [C7,#9385]', () => {
  const allowlist = JSON.stringify({ version: 1, files: {
    'packages/x/tests/hash.test.js': { kinds: ['hash'], reason: 'person-approved text pinned by hash' },
    'packages/x/tests/count.test.js': { kinds: ['hash'], reason: 'wrong kind' },
    'apps/y/tests/snapshot.test.js': { reason: 'data shipped to users' },
  } });
  const found = literalPinRows(rowsOf(FILES), { enabled: true, allowlist });
  assert.deepEqual(found.map(row => row.split(':')[0]), ['packages/x/tests/count.test.js', 'packages/x/tests/engine.test.js'],
    'the hash file and the no-kinds snapshot file pass; a file allowed another kind still fails for its own');
});

test('gate.logic-literal-pins.with-gate-literalpins-off-which: clause 2: with gate.literalPins off, which is the default, the lint reports nothing and refuses nothing [C7,#9385]', () => {
  assert.deepEqual(literalPinRows(rowsOf(FILES)), []);
  assert.deepEqual(literalPinRows(rowsOf(FILES), { enabled: false }), []);
  assert.deepEqual(literalPinRows(rowsOf(FILES), { enabled: 'yes' }), [], 'only an exact true turns it on');
  assert.equal(literalPinRows(rowsOf(FILES), { enabled: true, allowlist: 'not json' }).length, 4, 'an unreadable allowlist approves nothing');
});
