/** Characterize admission of imports through compatibility shims [C7]. */
/** @pullboard-test-input source-cell packages/codemap */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shimImportProblems, stagedShimImportProblems } from '../../../src/io/shim/ratchet.js';

const importer = 'packages/cli/src/request.js';
const shim = 'packages/state/src/legacy.js';
const moved = 'packages/state/src/request.js';
const frontDoor = 'packages/state/index.js';
const specifier = '../../state/src/legacy.js';
const criterion = `${importer} -> ${shim}`;
const plan = { cells: [{ paths: [[shim, moved]], frontDoor }] };
const parser = sources => sources.map(source => [source.match(/import\s+(['"])(.*?)\1/u)?.[2]]);

/** Provide immutable revision reads and count plan access for no-import cases. */
function reader(files = {}) {
  const reads = [];
  return { reads, read(revision, path) { reads.push([revision, path]); return files[`${revision}:${path}`] ?? files[path]; } };
}

/** A committed shim, moved implementation, and valid bounded exception. */
function files(overrides = {}) {
  return {
    [`before:${shim}`]: `export { request } from './request.js';\n`,
    [`after:${shim}`]: `export { request } from './request.js';\n`,
    [`before:${moved}`]: 'export const request = true;\n',
    [`after:${moved}`]: 'export const request = true;\n',
    'packages/codemap/data/plan/temporary-edges.json': JSON.stringify({ version: 1, edges: [
      { importer, target: shim, contractItem: 12797, expires: '2099-12-31' },
    ] }),
    ...overrides,
  };
}

/** One new declaration is checked against both the unchanged and accepted multisets. */
function check({ before = '', after, accepted = '', planRows = [plan], read = reader(files()).read,
  imports = parser, exception = criterion, now = Date.parse('2026-11-21T00:00:00Z') }) {
  return shimImportProblems({ changes: [{ file: importer, before, after, accepted }], plans: planRows,
    read, parseImports: imports, criterion: exception, now });
}

test('codemap.io-shim-ratchet.added-import-refuses: new static, re-export and literal dynamic imports through a shim refuse [C7]: clause 1: added import through shim is refused', () => {
  for (const declaration of [
    `import '${specifier}';`,
    `export { request } from '${specifier}';`,
    `await import('${specifier}');`,
  ]) {
    const problems = check({ after: declaration });
    assert.equal(problems.length, 1, declaration);
    assert.match(problems[0], new RegExp(`added import through compatibility shim ${shim.replaceAll('/', '\\/')}`));
  }
});

test('codemap.io-shim-ratchet.unchanged-multiset-passes: before and accepted duplicate declaration counts are preserved [C7]: clause 2: unchanged multiset passes', () => {
  const declaration = `import '${specifier}';`;
  assert.deepEqual(check({ before: declaration, accepted: `${declaration}\n${declaration}`, after: `${declaration}\n${declaration}` }), []);
});

test('codemap.io-shim-ratchet.temporary-edge-is-bounded: exact criterion edge and valid metadata admit only the contracted import [C7]: clause 3: temporary edge is bounded', () => {
  assert.deepEqual(check({ after: `import '${specifier}';` }), []);
  assert.equal(check({ after: `import '${specifier}';`, exception: `${importer} -> ${frontDoor}` }).length, 1);
  const expired = reader(files({ 'packages/codemap/data/plan/temporary-edges.json': JSON.stringify({ version: 1, edges: [
    { importer, target: shim, contractItem: 12797, expires: '2026-11-20' },
  ] }) }));
  assert.equal(check({ after: `import '${specifier}';`, read: expired.read }).length, 1);
});

test('codemap.io-shim-ratchet.no-added-import-no-plan-read: unchanged declarations never consult the plan [C7]: clause 4: no added import means no plan read', () => {
  const declaration = `import '${specifier}';`;
  const sourceReader = reader();
  assert.deepEqual(check({ before: declaration, after: declaration, accepted: declaration,
    read: sourceReader.read, planRows: [], imports: null }), []);
  assert.deepEqual(sourceReader.reads, []);
});

test('codemap.io-shim-ratchet.parser-required: an added import requires the canonical parser [C7]: parser refusal remains', () => {
  assert.throws(() => check({ after: `import '${specifier}';`, imports: null }),
    { code: 'SHIM_IMPORT_PARSER' });
});

test('codemap.io-shim-ratchet.malformed-plan-refuses: malformed plan rows retain their explicit refusal [C7]: malformed plan refusal remains', () => {
  const malformed = reader({
    [`HEAD:${importer}`]: '',
    [`:index:${importer}`]: `import '${specifier}';`,
    'HEAD:packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [{ file: '../outside.json' }] }),
  });
  assert.throws(() => stagedShimImportProblems({ paths: [importer], read: malformed.read, parseImports: parser }),
    { code: 'SHIM_IMPORT_PLAN' });
});
