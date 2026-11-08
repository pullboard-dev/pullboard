/** @pullboard-test-input source-tree */
/** @pullboard-world-pin: clause 1 reads the repository tree to prove the file moved; clause 2 runs the repository cells checks. */
/** The cells checks replay a saved answer for an unchanged commit, tree and diff, and miss on any change [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { cachedCellsRun, cellsCacheEnabled, cellsStateKey } from '../packages/codemap/index.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Run one cached check that prints in both streams and counts how often it really ran. */
function run(root, label, code, counter, options = { enabled: true }) {
  const out = [], error = [], log = console.log, warn = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => error.push(args.join(' '));
  let result;
  try {
    result = cachedCellsRun(root, label, () => { counter.n++; console.log('note'); console.error('problem'); return code; }, options);
  } finally { console.log = log; console.error = warn; }
  return { result, out, error };
}

test('a repeat on the same state replays the output and exit code without running the check [C7]', t => {
  const { root } = fixture(t), counter = { n: 0 };
  const first = run(root, ['--check'], 1, counter), second = run(root, ['--check'], 1, counter);
  assert.equal(counter.n, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(second, { result: 1, out: ['note'], error: ['problem'] });
});

test('changing a tracked file, an untracked file or the commit misses the cache [C7]', t => {
  const { root, put } = fixture(t), counter = { n: 0 };
  run(root, ['--check'], 0, counter);
  put('src/stats.js', 'export const stats = 2;\n');
  run(root, ['--check'], 0, counter);
  assert.equal(counter.n, 2, 'a dirty tracked change misses');
  put('src/new.js', 'export const n = 1;\n');
  run(root, ['--check'], 0, counter);
  assert.equal(counter.n, 3, 'an untracked file misses');
  run(root, ['--check'], 0, counter);
  assert.equal(counter.n, 3, 'the same dirty state hits');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'second');
  run(root, ['--check'], 0, counter);
  assert.equal(counter.n, 4, 'a new commit misses');
});

test('another mode or argument is its own entry, and a refusal is never saved [C7]', t => {
  const { root } = fixture(t), counter = { n: 0 };
  run(root, ['--cuts', 'a'], 0, counter);
  run(root, ['--cuts', 'b'], 0, counter);
  assert.equal(counter.n, 2);
  assert.throws(() => cachedCellsRun(root, ['--moved', 'a'], () => { throw new Error('refused'); }, { enabled: true }), /refused/u);
  run(root, ['--moved', 'a'], 0, counter);
  assert.equal(counter.n, 3, 'the run after a refusal executes');
});

test('with the setting off the check always runs and nothing is saved [C7]', t => {
  const { root } = fixture(t), counter = { n: 0 };
  run(root, ['--check'], 0, counter, { enabled: false });
  run(root, ['--check'], 0, counter, { enabled: false });
  assert.equal(counter.n, 2);
  assert.equal(cellsCacheEnabled(root), false);
  assert.match(cellsStateKey(root), /^[0-9a-f]{64}$/u);
  const dir = git(root, 'rev-parse', '--git-path', 'pullboard-cells-cache');
  assert.throws(() => readdirSync(join(root, dir)), /ENOENT/u);
});

test('the cache setting is off by default and described [C7]', () => {
  const config = spawnSync(process.execPath, ['-e', "import('./src/config.js').then(m => console.log(JSON.stringify(m.defaults().cells)))"], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(config.stdout.trim(), '{"cache":false,"shimMaxAgeDays":7}');
});


test('clean lint receipts survive a same-tree commit and another worktree [V4,C7]', t => {
  const { root } = fixture(t), counter = { n: 0 };
  run(root, ['cell-lints', '--check'], 0, counter);
  git(root, 'commit', '--allow-empty', '-q', '-m', 'same tree');
  const repeated = run(root, ['cell-lints', '--check'], 0, counter);
  assert.equal(counter.n, 1, 'a new commit with the same tree reuses lint');
  assert.match(repeated.error.join('\n'), /lint check reused receipt/u);
  const landing = `${root}-landing`;
  t.after(() => rmSync(landing, { recursive: true, force: true }));
  git(root, 'worktree', 'add', '-q', '--detach', landing, 'HEAD');
  const landed = run(landing, ['cell-lints', '--check'], 0, counter);
  assert.equal(counter.n, 1, 'landing reuses the submit lint receipt');
  assert.match(landed.error.join('\n'), /lint check reused receipt/u);
});


test('lint checker entry modules and their transitive helpers invalidate receipts [V4,C7]', t => {
  const { root } = fixture(t), counter = { n: 0 };
  const entry = `${root}-checker.js`, helper = `${root}-helper.js`;
  t.after(() => { rmSync(entry, { force: true }); rmSync(helper, { force: true }); });
  writeFileSync(entry, `import ${JSON.stringify(helper)};\n`);
  writeFileSync(helper, '// helper v1\n');
  const options = { enabled: true, code: [entry] };
  run(root, ['cell-lints', '--check'], 0, counter, options);
  run(root, ['cell-lints', '--check'], 0, counter, options);
  assert.equal(counter.n, 1, 'an unchanged checker runs once');
  writeFileSync(helper, '// helper v2\n');
  run(root, ['cell-lints', '--check'], 0, counter, options);
  assert.equal(counter.n, 2, 'a transitive checker module misses both caches');
  writeFileSync(entry, `import ${JSON.stringify(helper)}; // entry v2\n`);
  run(root, ['cell-lints', '--check'], 0, counter, options);
  assert.equal(counter.n, 3, 'a changed entry misses both caches');
});

test('clause 1: src/cells-cache.js is gone and its leaf sits in the codemap cell [C7]', () => {
  assert.equal(existsSync(join(ROOT, 'src/cells-cache.js')), false);
  assert.equal(existsSync(join(ROOT, 'packages/codemap/src/shell/cells-cache.js')), true);
});

test('clause 2: the cells plan check and the cells edges check both pass [C7]', () => {
  for (const args of [['bin/cells-plan.js', '--check'], ['bin/checks/cells-edges.js']]) {
    const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, `${args.join(' ')} exited ${run.status}: ${run.stderr}`);
  }
});
