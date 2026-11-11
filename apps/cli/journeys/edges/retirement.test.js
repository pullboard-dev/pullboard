/** @pullboard-test-input source-tree */
/** A named `plan retire entry <path>` line lets an accepted process entry leave the plan only once its file stopped running [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyProblems } from '../../index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';

const ENTRY = 'bin/entry.js';
const SOURCE = "import { fileURLToPath } from 'node:url';\nif (process.argv[1] === fileURLToPath(import.meta.url)) await Promise.resolve(process.argv.slice(2));\n";

/** An accepted plan holding one process entry, and the candidate plan that drops only the entries row. */
function plans() {
  const cell = { name: 'app:lib', order: 1, kind: 'app', root: 'apps/lib', frontDoor: 'apps/lib/index.js',
    paths: [[ENTRY, 'apps/lib/src/shell/entry.js', 'rule']], reexports: [], imports: [], cuts: [], ratchets: {}, item: { after: [] } };
  const before = { cells: [cell], stays: [], entries: [{ path: ENTRY, cell: 'app:lib' }] };
  return { before, after: { ...before, entries: [] } };
}

/** The ownership problems policyProblems reports for the candidate root under one criterion. */
function ownership(root, criterion) {
  const { before, after } = plans();
  return policyProblems(before, after, new Map(), new Map(), root, root, criterion).filter(problem => problem.includes('process entry ownership'));
}

test('clause 1: a named plan retire entry for an entry file that is gone is accepted without an ownership change [C7]', t => {
  const { root } = fixture(t);
  assert.deepEqual(ownership(root, `Retire the old worker. plan retire entry ${ENTRY}.`), []);
});

test('clause 1: removing an accepted process entry with no plan retire entry line still refuses [C7]', t => {
  const { root } = fixture(t);
  assert.deepEqual(ownership(root, 'Preserve actual cell boundaries.'), [`accepted process entry ownership changed: ${ENTRY}`]);
  assert.deepEqual(ownership(root, `plan retire entry ${ENTRY}.map`), [`accepted process entry ownership changed: ${ENTRY}`], 'a longer path never approves it');
});

test('clause 1: a named plan retire entry for a file that still runs as a process still refuses [C7]', t => {
  const { root, put } = fixture(t);
  put(ENTRY, SOURCE);
  assert.deepEqual(ownership(root, `plan retire entry ${ENTRY}.`), [`accepted process entry ownership changed: ${ENTRY}`]);
});

test('clause 1: a named plan retire entry whose path cannot be inspected as a file still refuses [C7]', t => {
  const { root, put } = fixture(t);
  put(`${ENTRY}/inner.js`, 'export const inner = 1;\n');
  assert.deepEqual(ownership(root, `plan retire entry ${ENTRY}.`), [`accepted process entry ownership changed: ${ENTRY}`],
    'a directory where the entry file was is an inspection failure, never a retirement');
});
