/** With census.skipUnchanged on, a census runs only the changed-input files and carries the earlier green rows of the others, marked carried [C7,#10383]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const quiet = { err() {}, say() {}, result() {} };

/** A private repo with tests a, b and c, each importing its own module, and a machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-carry-');
  const repo = join(box.root, 'repo'), home = join(box.root, 'machine-home');
  mkdirSync(repo); mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  if (settings) fixtureMachineSettings(home, settings);
  box.write('repo/package.json', '{"type":"module","private":true}\n');
  for (const name of ['a', 'b', 'c']) { box.write(`repo/src/${name}.js`, `export const ${name} = 1;\n`); box.write(`repo/${name}.test.js`, `import './src/${name}.js';\n`); }
  fixtureCommitAll(repo);
  return { repo, box, commit: () => { fixtureCommitAll(repo); return runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }).trim(); } };
}

/** A green shard dispatcher that records the files it was asked to run. */
const dispatcher = calls => async ({ files, write }) => {
  calls.push([...files]);
  write('# landing shard 1/1 attempt 1 on host: green in 900 ms\n');
  write(`${files.flatMap(file => [`# landing-file-ms 100 ${file}`, `# landing-file-exit 0 ${file}`]).join('\n')}\n# tests ${files.length}\n# pass ${files.length}\n`);
  write('# landing result: done\n');
  return { isGreen: true };
};

/** The rows of the newest census file for a sha, by file. */
const rowsFor = (repo, sha) => {
  const dir = join(repo, '.git', 'pullboard', 'census');
  const name = readdirSync(dir).find(entry => entry.endsWith('.jsonl') && entry.includes(sha.slice(0, 10)));
  return Object.fromEntries(readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).map(row => [row.file, row]));
};

test('clause 1: with census.skipUnchanged on, a census on a descendant sha runs only the changed-input file and writes carried green rows for the others, one row per file [C7,#10383]', async (t) => {
  const { repo, box, commit } = fixture(t, { census: { skipUnchanged: true } });
  const calls = [];
  assert.equal(await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher(calls) }), 0);
  const first = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }).trim();
  assert.deepEqual(calls[0].toSorted(), ['a.test.js', 'b.test.js', 'c.test.js']);
  box.write('repo/src/a.js', 'export const a = 2;\n');
  const second = commit();
  assert.equal(await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher(calls) }), 0);
  assert.deepEqual(calls[1], ['a.test.js']);
  const rows = rowsFor(repo, second);
  assert.deepEqual(Object.keys(rows).toSorted(), ['a.test.js', 'b.test.js', 'c.test.js']);
  assert.equal(rows['a.test.js'].carried, undefined);
  for (const file of ['b.test.js', 'c.test.js']) { assert.equal(rows[file].status, 'green'); assert.equal(rows[file].carried, true); assert.equal(rows[file].carriedFrom, first); }
});

test('clause 1: with the setting off, or a census with no earlier one, every file runs and no row is marked carried [C7,#10383]', async (t) => {
  const { repo, box, commit } = fixture(t);
  const calls = [];
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher(calls) });
  box.write('repo/src/a.js', 'export const a = 2;\n');
  const second = commit();
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher(calls) });
  assert.deepEqual(calls[1].toSorted(), ['a.test.js', 'b.test.js', 'c.test.js']);
  assert.ok(Object.values(rowsFor(repo, second)).every(row => row.carried === undefined));
});
