/** Test selection reuses machine-wide parse results, so a one-file change costs its diff and picks the same tests [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../packages/gate/index.js';
import { runFixtureGit } from './fixture-child.js';

const MODULES = 300;

/** A real Git repository of a chained module tree with one test per tenth module. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-selection-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run real Git in the fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Write a fixture path. */
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  /** Commit the tree and return its id. */
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'chore: selection cache fixture'); return git('rev-parse', 'HEAD').trim(); };
  git('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  for (let index = 0; index < MODULES; index += 1) {
    put(`src/m${index}.js`, `${index ? `import './m${index - 1}.js';\n` : ''}export const value${index} = ${index};\n`);
    if (index % 10 === 0) put(`test/t${index}.test.js`, `import '../src/m${index}.js';\n`);
  }
  return { root, git, put, commit };
}

/** Run `work` with the machine-wide parse store pointed at `directory`. */
function withStore(directory, work) {
  const saved = process.env.PULLBOARD_PARSE_CACHE_DIR;
  process.env.PULLBOARD_PARSE_CACHE_DIR = directory;
  try { return work(); } finally { if (saved === undefined) delete process.env.PULLBOARD_PARSE_CACHE_DIR; else process.env.PULLBOARD_PARSE_CACHE_DIR = saved; }
}

test('a warm one-file selection takes under 2 s and picks what a cold selection picks [C7,V4]', t => {
  const box = repository(t);
  const warmStore = mkdtempSync(join(tmpdir(), 'pullboard-parse-warm-'));
  const coldStore = mkdtempSync(join(tmpdir(), 'pullboard-parse-cold-'));
  t.after(() => { rmSync(warmStore, { recursive: true, force: true }); rmSync(coldStore, { recursive: true, force: true }); });
  const first = box.commit();
  box.put('src/m5.js', 'import \'./m4.js\';\nexport const value5 = 55;\n');
  const second = box.commit();
  withStore(warmStore, () => selectAffectedTests(box.root, { base: first, commit: second }));
  assert.ok(existsSync(join(warmStore, 'parse-results.sqlite')), 'the first selection fills the machine-wide store');
  box.put('src/m47.js', 'import \'./m46.js\';\nexport const value47 = 4747;\n');
  const third = box.commit();
  const started = Date.now();
  const warm = withStore(warmStore, () => selectAffectedTests(box.root, { base: second, commit: third }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `warm selection took ${elapsed} ms`);
  const cold = withStore(coldStore, () => selectAffectedTests(box.root, { base: second, commit: third }));
  assert.deepEqual(warm, cold);
  const expected = Array.from({ length: 25 }, (_, at) => `test/t${(at + 5) * 10}.test.js`).sort();
  assert.deepEqual(warm.files, expected);
});
