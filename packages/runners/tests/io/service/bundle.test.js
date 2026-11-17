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
