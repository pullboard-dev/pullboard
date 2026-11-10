/** A red batch's base split answers untouched files from the main-red cache and a new base gets its refresh [C7,#3268]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { splitBaseRed } from '../../../src/io/step/diagnose.js';
import { startBaseRefresh } from '../../../src/io/step/publish.js';

/** A real repository: a base commit with two test files, then a head commit changing only a.test.js. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pb-split-cached-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.test.js'), '// a\n');
  writeFileSync(join(root, 'b.test.js'), '// b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'a.test.js'), '// a changed\n');
  git('commit', '-q', '-am', 'batch');
  return { root, base };
}

/** A main comparison result with one red row naming one case. */
const red = (main, file, extra = {}) => ({ main, files: [{ file, result: 'red', failures: [{ name: 'case' }] }], ...extra });

test('clause 1: an untouched file is answered from the cache with no comparison and reported known [C7]', async t => {
  const { root, base } = repo(t);
  const said = [], compared = [];
  const state = { batch: { root, base }, say: line => said.push(line) };
  const compare = async (_root, profile) => { compared.push(profile.tests[0].file); return red(base, profile.tests[0].file, { runner: 'runner-7' }); };
  const carry = file => ({ main: 'f'.repeat(40), files: [{ file, result: 'red', failures: [{ name: 'case' }] }], carried: true });
  const failures = [{ file: 'a.test.js', name: 'case' }, { file: 'b.test.js', name: 'case' }];
  const split = await splitBaseRed(state, failures, compare, () => true, carry);
  assert.deepEqual(compared, ['a.test.js'], 'only the changed file is compared');
  assert.deepEqual(split.known.map(f => f.file).sort(), ['a.test.js', 'b.test.js']);
  assert.ok(said.some(line => line.includes('b.test.js') && line.includes('ffffffffffff')));
});

test('clause 2: a base with no cache entry spawns the refresh once from the newest generation [C7]', () => {
  const launched = [], said = [];
  const state = { root: '/repo', say: line => said.push(line) };
  const batch = { base: 'b'.repeat(40) };
  const newest = 'c'.repeat(40);
  const started = startBaseRefresh(state, batch, { source: () => newest, launch: (...args) => launched.push(args) });
  assert.deepEqual(started, { previous: newest, published: batch.base });
  assert.deepEqual(launched, [['/repo', newest, batch.base]]);
  // A batch that records refreshStarted never spawns it again.
  assert.equal(startBaseRefresh(state, { ...batch, refreshStarted: started }, { source: () => newest, launch: () => assert.fail('spawned twice') }), null);
  // A cached base or an empty cache starts nothing.
  assert.equal(startBaseRefresh(state, batch, { source: () => null, launch: () => assert.fail('nothing to refresh from') }), null);
});

test('clause 3: two files\' comparisons start within 5 s and each logs file, runner and duration [C7]', async t => {
  const { root, base } = repo(t);
  const said = [], starts = new Map();
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const state = { batch: { root, base }, say: line => said.push(line) };
  const compare = async (_root, profile, _wait, _out, options) => {
    const file = profile.tests[0].file;
    options.onStart({ file, runner: `runner-${file[0]}` });
    starts.set(file, Date.now());
    // Neither comparison finishes until both have started, so serial comparisons would never get here.
    if (starts.size === 2) release(); else await released;
    return red(base, file, { runner: `runner-${file[0]}` });
  };
  // Both files changed, so neither is carried; both compare at once.
  writeFileSync(join(root, 'b.test.js'), '// b changed\n');
  spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'more'], { cwd: root });
  const split = await splitBaseRed(state, [{ file: 'a.test.js', name: 'case' }, { file: 'b.test.js', name: 'case' }], compare, () => true, () => null);
  assert.equal(split.known.length, 2);
  assert.ok(Math.abs(starts.get('a.test.js') - starts.get('b.test.js')) < 5000);
  for (const file of ['a.test.js', 'b.test.js']) {
    assert.ok(said.some(line => line.includes(`comparing ${file}`) && line.includes(`started on runner runner-${file[0]}`)), `start line for ${file}`);
    assert.ok(said.some(line => line.includes(file) && line.includes(`runner-${file[0]}`) && /\(\d+ ms\)/u.test(line)), `end line for ${file}`);
  }
});
