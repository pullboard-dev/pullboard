/** Exact generated-data declarations never turn a moved repository source into fixture data [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSourceEdits } from '../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import {
  parseDataReads,
  staleDataReads,
} from '../../../../packages/codemap/src/io/cells-data-reads.js';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureGit } from '../../tests/fixtures/child.js';

const FILE = 'test/example.test.js';
const SOURCE = "import { readFileSync } from 'node:fs';\nconst generated = process.env.GENERATED_HOOK;\nreadFileSync(generated, 'utf8');\n";
const ROW = { file: FILE, line: 3, expression: 'generated', kind: 'hook', why: 'The fixture receives its generated installed hook path through its private environment.' };

test('an exact listed generated-data operand is accepted without rewriting source [C7,CD64]', () => {
  const result = fixtureSourceEdits(SOURCE, { file: FILE, moves: [['src/hooks.js', 'packages/commits/src/io/hooks.js']], dataReads: [ROW] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.matchedDataReads, [ROW]);
  assert.ok(result.excluded.some(line => line.includes('manifest') && line.includes('hook')));
});

/** A real tracked private repository keeps the manifest scanner's file inventory and snapshot binding intact. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cell-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root });
  const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const target = 'packages/commits/src/io/hooks.js';
  write('package.json', JSON.stringify({ type: 'module', bin: 'src/hooks.js' }));
  write('packages/commits/index.js', `export * from './src/io/hooks.js';\n`);
  write(target, 'export const hooks = true;\n');
  write('src/hooks.js', "export * from '../packages/commits/index.js';\n");
  write(FILE, SOURCE);
  write('packages/codemap/data/plan/data-reads/commits.json', JSON.stringify({ version: 1, reads: [ROW] }));
  /** Commit real source bytes before each static snapshot analysis. */
  const commit = () => { git('add', '-A'); git('commit', '-q', '-m', 'chore: private manifest fixture'); };
  commit();
  const plan = { cells: [{ name: 'commits', frontDoor: 'packages/commits/index.js', paths: [['src/hooks.js', target]] }] };
  return { write, commit, git, check: () => checkMoved(root, plan, 'commits') };
}

test('the real move scanner consumes exact manifest rows even without a moved basename in the reader [C7,CD64]', t => {
  const p = project(t);
  assert.deepEqual(p.check(), []);
});

test('the same data expression on another line stays unsupported and its old declaration is stale [C7,CD64]', t => {
  const p = project(t);
  p.write(FILE, '\n' + SOURCE); p.commit();
  const problems = p.check();
  assert.ok(problems.some(row => row.startsWith(`${FILE}:4: unsupported fixture source`)));
  assert.ok(problems.some(row => row.startsWith(`${FILE}:3: stale generated-data manifest`)));
});

test('a deleted expression is stale even when the file no longer has a filesystem binding or moved basename [C7,CD64]', t => {
  const p = project(t);
  p.write(FILE, 'export const readerWasRemoved = true;\n'); p.commit();
  assert.deepEqual(p.check(), [`${FILE}:3: stale generated-data manifest expression "generated"`]);
});

test('a manifest never masks a resolved moved repository source operand [C7,CD64]', () => {
  const expression = "new URL('../src/hooks.js', import.meta.url)";
  const source = `import { readFileSync } from 'node:fs';\nreadFileSync(${expression}, 'utf8');\n`;
  const row = { ...ROW, line: 2, expression };
  const result = fixtureSourceEdits(source, { file: FILE, moves: [['src/hooks.js', 'packages/commits/src/io/hooks.js']], dataReads: [row] });
  assert.equal(result.edits.length, 1, 'the real source still needs its move rewrite');
  assert.deepEqual(result.matchedDataReads ?? [], []);
  assert.equal(staleDataReads([row], result.matchedDataReads ?? []).length, 1);
});

test('malformed and duplicate data declarations fail closed [C7,CD64]', () => {
  assert.deepEqual(parseDataReads({ version: 1, reads: [ROW] }).problems, []);
  for (const reads of [[ROW, ROW], [{ ...ROW, file: '../outside.js' }], [{ ...ROW, line: 0 }], [{ ...ROW, kind: 'source' }], [{ ...ROW, why: '' }]]) {
    const result = parseDataReads({ version: 1, reads });
    assert.ok(result.problems.length);
    assert.deepEqual(result.reads, []);
  }
});

test('an uncommitted manifest edit cannot supply data-read authority [C7,CD64]', t => {
  const p = project(t);
  // A real dynamic operand selects this reader even when its manifest has no authority.
  p.write(FILE, SOURCE.replace('process.env.GENERATED_HOOK;', "process.env.GENERATED_HOOK + '/hooks.js';"));
  p.commit();
  p.write('packages/codemap/data/plan/data-reads/commits.json', JSON.stringify({ version: 1, reads: [{ ...ROW, why: 'Uncommitted altered declaration.' }] }));
  const problems = p.check();
  assert.ok(problems.some(row => row.includes('manifest differs from its committed snapshot')));
  assert.ok(problems.some(row => row.startsWith(`${FILE}:3: unsupported fixture source`)));
});

test('an untracked manifest cannot supply data-read authority [C7,CD64]', t => {
  const p = project(t);
  // A real dynamic operand selects this reader even when its manifest has no authority.
  p.write(FILE, SOURCE.replace('process.env.GENERATED_HOOK;', "process.env.GENERATED_HOOK + '/hooks.js';"));
  p.commit();
  p.git('rm', '--cached', 'packages/codemap/data/plan/data-reads/commits.json');
  p.git('commit', '-q', '-m', 'chore: remove tracked declaration while retaining its untracked bytes');
  const problems = p.check();
  assert.ok(problems.some(row => row.includes('manifest must be a committed regular file')));
  assert.ok(problems.some(row => row.startsWith(`${FILE}:3: unsupported fixture source`)));
});
