/** Test selection reads main's graph machine-wide and re-parses only the files a candidate changes [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeMapGraph } from '../../../../../index.js';
import { selectAffectedTests } from '../../../../../index.js';
import { runFixtureGit } from '../../../../fixtures/child.js';

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

/** Run `work` with the machine-wide state (graphs and parse results) rooted at `directory`. */
function onMachine(directory, work) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  try { return work(); } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A fresh checkout: a new clone with its own Git directory, so no per-repository cache can carry over. */
function freshCheckout(t, box) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-selection-clone-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'checkout');
  box.git('clone', '-q', '--no-hardlinks', box.root, root);
  return { root, git: (...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' } }) };
}

/** A probe that counts full graph builds and records which modules were wired and which source texts were parsed. */
const probe = () => ({ builds: 0, imported: [], parsed: [] });

test('gate.io-affected-graph-cache-selection.a-fresh-clone-reads-main-s: a fresh clone reads main\'s graph and parses only the one changed file, picking what a cold build picks [C7,V4]', t => {
  const box = repository(t);
  const warmMachine = mkdtempSync(join(tmpdir(), 'pullboard-machine-warm-'));
  const coldMachine = mkdtempSync(join(tmpdir(), 'pullboard-machine-cold-'));
  t.after(() => { rmSync(warmMachine, { recursive: true, force: true }); rmSync(coldMachine, { recursive: true, force: true }); });
  const main = box.commit();
  // Another job on this machine already selected against main, which stores main's graph machine-wide.
  box.put('src/m5.js', "import './m4.js';\nexport const value5 = 55;\n");
  const earlier = box.commit();
  onMachine(warmMachine, () => selectAffectedTests(box.root, { base: main, commit: earlier }));
  assert.ok(existsSync(join(warmMachine, 'main-facts', 'facts.sqlite')), 'the main graph is stored outside any checkout');
  // A later job: a fresh clone and a candidate that changes one file.
  const fresh = freshCheckout(t, box);
  fresh.git('checkout', '-q', '-b', 'item', main);
  writeFileSync(join(fresh.root, 'src/m47.js'), "import './m46.js';\nexport const changedMarker47 = 4747;\n");
  fresh.git('add', '-A'); fresh.git('commit', '-qm', 'feat: change one module');
  const candidate = fresh.git('rev-parse', 'HEAD').trim();
  const warmProbe = probe();
  const started = Date.now();
  const warm = onMachine(warmMachine, () => selectAffectedTests(fresh.root, { base: main, commit: candidate, probe: warmProbe }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `warm selection took ${elapsed} ms`); // budget: declared ceiling in the item #2536 criterion, selection under 2 s warm
  assert.equal(warmProbe.builds, 0, 'main\'s graph is read, not built');
  assert.deepEqual(warmProbe.imported, ['src/m47.js'], 'only the changed file is parsed for imports');
  assert.ok(warmProbe.parsed.length > 0 && warmProbe.parsed.every(source => source.includes('changedMarker47')), 'the parser saw no other file');
  assert.equal(existsSync(join(fresh.root, '.git', 'pullboard-main-facts')), false, 'nothing is stored beside the checkout');
  const coldProbe = probe();
  const cold = onMachine(coldMachine, () => selectAffectedTests(fresh.root, { base: main, commit: candidate, probe: coldProbe }));
  assert.ok(coldProbe.builds >= 1 && coldProbe.imported.length >= MODULES, 'a cold machine builds the whole graph');
  assert.deepEqual(warm, cold);
  assert.deepEqual(warm.files, Array.from({ length: 25 }, (_, at) => `test/t${(at + 5) * 10}.test.js`).sort());
});

test('gate.io-affected-graph-cache-selection.a-graph-updated-from-the-base: a graph updated from the base equals one built from scratch, and a changed path set rebuilds [C7,V4]', t => {
  const box = repository(t);
  const machine = mkdtempSync(join(tmpdir(), 'pullboard-machine-delta-'));
  t.after(() => rmSync(machine, { recursive: true, force: true }));
  const main = box.commit();
  /** Plain data for every part of a graph selection reads, with sets and maps in canonical order. */
  const shape = graph => JSON.stringify([graph.paths, [...graph.reverse].map(([k, v]) => [k, [...v].sort()]).sort(), [...graph.unknown].sort(),
    [...graph.undeclared].sort(), [...graph.modules].sort(), [...graph.blobs].sort(), [...graph.imports].sort(), [...graph.testTreeReaders].sort(),
    [...graph.sourceTreeReaders].sort(), graph.importMap]);
  onMachine(machine, () => {
    box.put('src/m7.js', "import './m6.js';\nimport './m2.js';\nexport const value7 = 77;\n");
    box.put('test/t20.test.js', "import '../src/m20.js';\nimport '../src/m9.js';\n");
    const edited = box.commit();
    const incremental = probe();
    const delta = codeMapGraph(box.root, edited, codeMapGraph(box.root, main), incremental);
    assert.deepEqual(incremental.imported.sort(), ['src/m7.js', 'test/t20.test.js'], 'only the changed modules are wired');
    assert.equal(shape(delta), shape(codeMapGraph(box.root, edited)));
    box.put('src/extra.js', "import './m1.js';\nexport const extra = 1;\n");
    const added = box.commit();
    const rebuilt = probe();
    const full = codeMapGraph(box.root, added, codeMapGraph(box.root, main), rebuilt);
    assert.equal(rebuilt.builds, 1, 'a new module path rebuilds the graph');
    assert.equal(shape(full), shape(codeMapGraph(box.root, added)));
  });
});
