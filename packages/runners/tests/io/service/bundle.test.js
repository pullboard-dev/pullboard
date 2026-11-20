/** @pullboard-test-input packages/state/src/logic/engines/** */
/** The runner service bundle carries every folder the runner lists at run time, and a runner runs from it alone [P7,#8734]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { serviceFiles } from '../../../src/io/service.js';
import { trustedEntries } from '../../../src/io/service.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const ENGINES = 'packages/state/src/logic/engines';
const REPO = new URL('../../../../../', import.meta.url);

test('runners.bundle.n8734-clause-1-servicefiles-carries-every: #8734 clause 1: serviceFiles() carries every file under packages/state/src/logic/engines/, though nothing imports them all [P7]', () => {
  const bundled = new Set(Object.keys(serviceFiles()));
  const leaves = readdirSync(new URL(`${ENGINES}/`, REPO), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => `${join(entry.parentPath, entry.name).slice(new URL(REPO).pathname.length)}`);
  assert.ok(leaves.length > 100, `${leaves.length} engine files`);
  assert.deepEqual(leaves.filter(leaf => !bundled.has(leaf)), []);
});

test('runners.bundle.n8734-clause-2-a-runner-started: #8734 clause 2: a runner started from a serviceFiles() bundle in a temporary folder runs one job and posts its receipt [P7]', { timeout: 120_000 }, // budget: one bundle write, one local git checkout and one node child.
  async t => {
    const { root: app } = privateFixtureFiles('pullboard-service-bundle-');
    const { root: trunk } = privateFixtureFiles('pullboard-service-trunk-');
    const { root: cache } = privateFixtureFiles('pullboard-service-cache-');
    t.after(() => { for (const folder of [app, trunk, cache]) rmSync(folder, { recursive: true, force: true }); });
    // Written as install-serve writes it: the files and a package.json that makes them ES modules, nothing else.
    for (const [path, text] of Object.entries(serviceFiles())) {
      mkdirSync(dirname(join(app, path)), { recursive: true });
      writeFileSync(join(app, path), text);
    }
    writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
    const { serveRunner } = await import(pathToFileURL(join(app, 'packages/drive/index.js')).href);
    const { pullGit } = await import(pathToFileURL(join(app, 'apps/cli/src/io/runner/git.js')).href);
    const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
    sh('init', '-q', '-b', 'main');
    writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'one');
    const commit = sh('rev-parse', 'HEAD');
    const reply = document => ({ status: 200, json: async () => document });
    const stop = new AbortController();
    let handed = 0, receipt = null;
    const fetchImpl = async (_url, { body }) => {
      const call = JSON.parse(body);
      if (call.action === 'claim') { handed += 1; return reply({ trunk, claim: handed > 1 ? null : { job: 'g1', attempt: 1, token: 't1', candidate: commit, base: commit, run: [] } }); }
      if (call.action === 'request') return reply({ request: { run: ['node', '-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log("PULLBOARD_GATE_RECEIPT " + JSON.stringify({ version: 1, green: true })));'], input: { main: commit, entry: 'x', data: {} }, commits: [] } });
      if (call.action === 'receipt') { receipt = call; stop.abort(); }
      return reply({ ok: true, renewed: true });
    };
    const { jobs } = await serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'r-bundle', capabilities: [], cache, jobs: 1, cores: 1, signal: stop.signal, fetchImpl });
    assert.equal(jobs.length, 1, JSON.stringify(jobs));
    assert.equal(jobs[0].outcome, 'posted', JSON.stringify(jobs[0]));
    assert.ok(receipt, 'the board got the receipt');
  });

/** Every repo file a trusted entry imports that the bundle lacks; the imports of those files are walked by serviceFiles(), which refuses a bundle with one missing. */
function missingFromBundle(bundle, entries) {
  return [...new Set(entries.flatMap(entry => entry.imports))].filter(path => bundle[path] === undefined);
}

test('runners.bundle.trusted-entries-closed: clause 1: the bundle holds every repo file the trusted job entries import, gate analysis entry included, and one without the cells cache module is reported [P7,#10826]', () => {
  const bundle = serviceFiles();
  const entries = trustedEntries();
  const analysis = entries.find(entry => entry.name === 'ANALYSIS_ENTRY');
  assert.ok(analysis, 'the gate analysis entry is found');
  for (const path of ['apps/cli/src/io/cells/cache.js', 'apps/cli/src/io/cells-submit-checks.js', 'apps/cli/src/io/memo.js']) {
    assert.ok(analysis.imports.includes(path), `${path} is imported by the analysis entry`);
  }
  assert.deepEqual(missingFromBundle(bundle, entries), []);
  const { 'apps/cli/src/io/cells/cache.js': _dropped, ...without } = bundle;
  assert.deepEqual(missingFromBundle(without, entries), ['apps/cli/src/io/cells/cache.js']);
});

test('runners.bundle.analysis-entry-links-from-bundle: clause 2: every module the gate analysis entry imports links from a bundle folder holding no packages/items of the board repo, with no missing module [P7,#10826]', { timeout: 120_000 }, // budget: one bundle write and the analysis entry's imports linked once.
  async t => {
    const { root: app } = privateFixtureFiles('pullboard-service-entry-');
    t.after(() => rmSync(app, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(serviceFiles())) {
      mkdirSync(dirname(join(app, path)), { recursive: true });
      writeFileSync(join(app, path), text);
    }
    writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
    const analysis = trustedEntries().find(entry => entry.name === 'ANALYSIS_ENTRY');
    assert.ok(analysis.imports.length >= 6, analysis.imports.join(' '));
    for (const path of analysis.imports) {
      await assert.doesNotReject(import(pathToFileURL(join(app, path)).href), path);
    }
  });
