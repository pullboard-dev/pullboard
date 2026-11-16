/** Committed graph cache retains unknown reach and isolates each consumer [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../fixtures/child.js';
import { codeMapGraph } from '../../../../index.js';
import { selectAffectedTests } from '../../../../index.js';
import { cachedAffectedGraph } from '../../../../index.js';
import { runFixtureGit } from '../../../fixtures/child.js';

/** A real immutable Git graph with a supported reader and an unresolved computed loader. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-graph-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run real Git without changing shared repository state. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Write a fixture path, retaining actual committed source bytes. */
  const put = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source);
  };
  /** Freeze the actual tree used by the selector. */
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'chore: graph cache fixture'); return git('rev-parse', 'HEAD').trim(); };
  git('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('src/value.js', 'export const value = 1;\n');
  put('test/value.test.js', "import '../src/value.js';\n");
  put('test/docs.test.js', "import { readFileSync } from 'node:fs'; readFileSync(new URL('../d\\x6fcs/one.md', import.meta.url));\n");
  put('docs/one.md', '# One\n'); put('docs/two.md', '# Two\n');
  return { root, git, put, commit };
}

test('cached committed graphs retain unknowns and give each consumer fresh containers [C7,V4]', t => {
  const box = repository(t);
  box.put('src/unknown.js', 'export const load = name => import(name);\n');
  box.put('test/unknown.test.js', "import '../src/unknown.js';\n");
  const commit = box.commit();
  const original = codeMapGraph(box.root, commit);
  assert.match(original.unknown.get('src/unknown.js'), /dynamic import/u);
  let calls = 0;
  /** Count actual graph derivation at the persistent-cache boundary, using the real parsed graph. */
  const derive = () => { calls += 1; return original; };
  // A fresh namespace key includes this real commit; the public graph call has already populated it.
  const first = cachedAffectedGraph(box.root, commit, derive);
  const second = cachedAffectedGraph(box.root, commit, derive);
  assert.equal(calls, 0, 'the real graph call published its immutable graph');
  first.unknown.clear(); first.modules.clear(); first.reverse.clear(); first.paths.length = 0;
  assert.match(second.unknown.get('src/unknown.js'), /dynamic import/u);
  assert.ok(second.modules.has('src/value.js'));
  assert.ok(second.reverse.get('src/value.js').has('test/value.test.js'));
  assert.ok(second.paths.includes('test/value.test.js'));
  const helper = new URL('../../../../index.js', import.meta.url).href;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    `import {cachedAffectedGraph} from ${JSON.stringify(helper)};
     const graph=cachedAffectedGraph(${JSON.stringify(box.root)},${JSON.stringify(commit)},()=>{throw new Error('duplicate derivation');});
     console.log(graph.unknown.get('src/unknown.js'));`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /dynamic import/u);
  // clause 1: a change reaching an unknown file selects its importers and the unknown roots, not the whole suite.
  const reached = selectAffectedTests(box.root, { base: commit, commit, changed: ['src/unknown.js'] });
  assert.equal(reached.full, false);
  assert.ok(reached.files.includes('test/unknown.test.js'), 'clause 2: the test reaching the unknown file is still selected');
  assert.ok(!reached.files.includes('test/value.test.js'), 'a test that never reaches the unknown file stays out');
});

test('documentation overlays and new commits cannot contaminate an immutable cached base [C7,V4]', t => {
  const box = repository(t); const base = box.commit();
  const one = selectAffectedTests(box.root, { base, commit: base, changed: ['docs/one.md'] });
  const two = selectAffectedTests(box.root, { base, commit: base, changed: ['docs/two.md'] });
  assert.equal(one.full, false); assert.deepEqual(one.files, ['test/docs.test.js']);
  assert.equal(two.full, false); assert.deepEqual(two.files, []);
  assert.equal(codeMapGraph(box.root, base).docInputs.size, 0);
  box.put('src/value.js', 'export const value = 2;\n'); const next = box.commit();
  assert.notEqual(codeMapGraph(box.root, base).blobs.get('src/value.js'), codeMapGraph(box.root, next).blobs.get('src/value.js'));
  box.put('src/value.js', 'uncommitted invalid bytes');
  assert.match(codeMapGraph(box.root, base).modules.get('src/value.js'), /value = 1/u);
});
