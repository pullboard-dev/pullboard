/** The shards and the analysis trip of one gate build and scan their runner request once per commit, not once each [C7,#5728]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { committedRunnerController } from '../../../../packages/runners/index.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../cli/tests/fixtures/child.js';

/** A `git` on PATH that logs each call's arguments, one line each, slows the scans by a second, then runs the real git. */
function loggingGit(box) {
  const real = runFixtureChild('sh', ['-c', 'command -v git'], { env: box.env, encoding: 'utf8' }).stdout.trim();
  const bin = join(box.dir, 'bin');
  const log = join(box.dir, 'git.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n# A slow scan, so every trip arrives while the first one still scans.\ncase "$*" in *ls-tree*|*check-ref-format*) sleep 1;; esac\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

test('clause 1: four requests for one commit at once, three shards and an analysis trip, scan its source and tags once and all reuse that answer [C7,#5728]', { timeout: 240_000 }, async t => {
  const box = cellSandbox(t);
  const tooling = join(box.dir, 'tooling'), project = join(box.dir, 'project'), home = join(box.dir, 'home');
  for (const folder of [tooling, project, home]) mkdirSync(folder, { recursive: true });
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), tooling);
  box.git(tooling, 'init', '-q', '-b', 'main');
  box.git(tooling, 'add', '-A');
  box.git(tooling, 'commit', '-q', '-m', 'test: scanner tooling');
  const exported = committedRunnerController(tooling);
  t.after(exported.cleanup);
  writeFileSync(join(project, 'a.js'), 'export const a = 1;\n');
  box.git(project, 'init', '-q', '-b', 'main');
  box.git(project, 'add', '-A');
  box.git(project, 'commit', '-q', '-m', 'test: clean source');
  box.git(project, 'tag', 'v1');
  const commit = box.git(project, 'rev-parse', 'HEAD');
  const tree = box.git(project, 'rev-parse', 'HEAD^{tree}');
  const git = loggingGit(box);
  const url = file => JSON.stringify(pathToFileURL(join(exported.root, file)).href);
  /**
   * One controller process preparing one runner trip of the gate: the source and tag scans requestFor
   * (packages/runners/src/io/request.js) runs on the trip's commit before it builds the request.
   */
  const trip = command => `// ${command}
const { sourceObjects } = await import(${url('packages/runners/src/io/source/scan.js')});
const { candidateTags } = await import(${url('packages/runners/src/io/pack.js')});
const source = { commit: ${JSON.stringify(commit)}, tree: ${JSON.stringify(tree)} };
const protection = sourceObjects(${JSON.stringify(project)}, source);
console.log(JSON.stringify({ commit: source.commit, protection, tags: candidateTags(${JSON.stringify(project)}, source) }));`;
  const env = { ...box.env, PULLBOARD_MACHINE_HOME: home, PATH: `${git.bin}:${box.env.PATH}` };
  // Process-level: concurrent gate trips are separate node processes sharing one tree memo.
  const trips = await Promise.all(['echo shard-1', 'echo shard-2', 'echo shard-3', 'echo analysis'].map(command =>
    runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', trip(command)], { cwd: project, env, encoding: 'utf8' })));
  for (const run of trips) assert.equal(run.status, 0, run.context ?? run.stderr);
  const answers = trips.map(run => JSON.parse(run.stdout.trim().split('\n').at(-1)));
  for (const answer of answers) assert.deepEqual(answer, answers[0], 'every trip carries the one answer');
  assert.equal(answers[0].commit, commit);
  assert.deepEqual(answers[0].tags.map(tag => tag.name), ['refs/tags/v1']);
  const calls = git.calls();
  assert.equal(calls.filter(line => line.includes(`ls-tree -r -z --full-tree ${commit}`)).length, 1, `the source objects were scanned once: ${calls.join('\n')}`);
  assert.equal(calls.filter(line => line.includes('check-ref-format refs/tags/v1')).length, 1, 'the tag selection was scanned once');
});

test('clause 1: concurrent key builds for one tree build once; every waiter reads the builder\'s memo [C7,#5728]', { timeout: 120_000 }, async t => {
  const box = cellSandbox(t);
  const store = join(box.dir, 'store');
  const count = join(box.dir, 'builds');
  writeFileSync(count, '');
  const memo = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/src/io/test/action/memo.js')).href);
  /** One gate trip asking for its own file's key from the shared tree memo. */
  const ask = file => `import { appendFileSync } from 'node:fs';
const { memoizedActionKeys } = await import(${memo});
const keys = await memoizedActionKeys(${JSON.stringify(store)}, 'tree-identity', [${JSON.stringify(file)}], async () => {
  appendFileSync(${JSON.stringify(count)}, 'build\\n');
  await new Promise(done => setTimeout(done, 1500)); // budget: a slow cold build, so every other trip arrives while it runs.
  return new Map(['a.test.js', 'b.test.js', 'c.test.js'].map(name => [name, { key: 'f'.repeat(64), inputKey: name, reason: '' }]));
}, { prune: false });
console.log(JSON.stringify([...keys]));`;
  // Process-level: three concurrent gate trips are separate node processes sharing one memo store.
  const runs = await Promise.all(['a.test.js', 'b.test.js', 'c.test.js'].map(file =>
    runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', ask(file)], { env: box.env, encoding: 'utf8' })));
  for (const run of runs) assert.equal(run.status, 0, run.context ?? run.stderr);
  assert.equal(readFileSync(count, 'utf8'), 'build\n', 'one build served all three trips');
  assert.deepEqual(runs.map(run => JSON.parse(run.stdout.trim())[0][0]), ['a.test.js', 'b.test.js', 'c.test.js'], 'each trip read its own key');
});
