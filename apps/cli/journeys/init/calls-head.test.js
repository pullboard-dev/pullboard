/** Prove cached Git HEAD facts refresh after a commit, for runners, a live server and concurrent commands [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { headCommit } from '../../../../packages/git/index.js';
import { withGitFacts } from '../../../../packages/git/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixture } from '../../tests/fixtures/init/calls.js';
import { advanceHead } from '../../tests/fixtures/init/calls.js';
import { GIT_MODULE } from '../../tests/fixtures/init/calls.js';

const RUN_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/runners/index.js')).href;
const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/config/src/io/main.js')).href;

test('cli.journeys-init-calls-head.a-runner-sees-the-new-head: a runner sees the new HEAD after it commits its item [C7]', async (t) => {
  const box = await fixture(t);
  fileFixtureItem(box, box.repo, { lane: 'core', title: 'Refresh cached HEAD', route: 'mid',
    criterion: 'the runner reads the commit it just made', check: 'test -f src/result.txt',
    brief: 'Files: src/result.txt\nChange: create the runner result file.\nTest: the runner reads the commit it just made.',
    diagnosis: 'Files: src/result.txt\nChange: create the runner result file.\nTest case: the runner reads the commit it just made.',
    args: ['--specs', 'C7'] });
  const agent = join(box.dir, 'agent.sh');
  writeFileSync(agent, '#!/bin/sh\nmkdir -p src\nprintf result > src/result.txt\n');
  chmodSync(agent, 0o700);
  // No detached review comparison: it keeps writing into the fixture, and the cleanup then retries past the file budget [C7].
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { mainComparison: 'off' } });
  const run = box.ok(box.worker, 'run', '--agent-light', `sh ${agent}`, '--items', '1', '--attempts', '1', '--minutes', '1');
  assert.match(run.stdout, /#1 is in the gate as job /u);
  const current = box.git(box.worker, 'rev-parse', 'HEAD');
  // A pull submit offers its gate at the commit the run made, and names it in the job id, so the offered job proves the runner's new HEAD [C7].
  const shown = JSON.parse(box.ok(box.repo, 'show', '1', '--json').stdout);
  assert.equal(shown.gateJob?.id.split(':')[2], current.slice(0, 12), 'submit offers the HEAD created by this command');
});

/** Create a promise gate for a deterministic overlap between command fact scopes. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Read a code reference through the running local API using a SHA-shaped current branch name. */
async function readServedBranchCode(api, branch) {
  const address = new URL(api.url);
  const headers = { 'x-pullboard-key': address.searchParams.get('k') };
  const listing = await fetchFresh(address, { headers });
  assert.equal(listing.status, 200);
  const board = (await listing.json()).boards[0];
  assert.ok(board?.id, 'the fixture board is listed');
  const path = `${address.pathname}/${encodeURIComponent(board.id)}/code?ref=${encodeURIComponent(`SPEC.md:1@${branch}`)}`;
  const response = await fetchFresh(address.origin + path, { headers });
  const document = await response.json();
  assert.equal(response.status, 200, JSON.stringify(document));
  return document.code.commit;
}

test('cli.journeys-init-calls-head.a-live-serve-request-sees-a: a live serve request sees a commit made while the server stays open [C7]', async (t) => {
  const box = await fixture(t);
  const branch = 'a1b2c3d4e5f6';
  box.git(box.repo, 'branch', '-m', branch);
  const original = box.git(box.repo, 'rev-parse', 'HEAD');
  await withGitFacts(async () => {
    assert.equal(headCommit(box.repo), original, 'the long-lived command has an initial cached HEAD');
    const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'git-facts-test-key', runCommand: main, projects: () => [{ root: box.repo, name: 'Git facts fixture' }] });
    try {
      assert.equal(await readServedBranchCode(api, branch), original);
      const advanced = advanceHead(box, 'advance the served branch', branch);
      assert.notEqual(advanced, original);
      assert.equal(await readServedBranchCode(api, branch), advanced, 'the next HTTP request resolves the branch after its commit');
    } finally {
      await api.close();
    }
  });
});

test('cli.journeys-init-calls-head.the-runner-invalidates-cached-head-immediately: the runner invalidates cached HEAD immediately after its own commit [C7]', async (t) => {
  const box = await fixture(t);
  const before = box.git(box.worker, 'rev-parse', 'HEAD');
  mkdirSync(join(box.worker, 'src'));
  writeFileSync(join(box.worker, 'src/runner-result.txt'), 'built\n');
  const item = { item_id: 1, item_title: 'runner commit refreshes HEAD', item_lane: 'core', item_spec_ids: 'C7' };
  const script = `import { commitWork } from ${JSON.stringify(RUN_MODULE)};
import { loadConfig } from ${JSON.stringify(CONFIG_MODULE)};
import { withGitFacts } from ${JSON.stringify(GIT_MODULE)};
const root = process.cwd();
const item = JSON.parse(process.env.PULLBOARD_TEST_ITEM);
const result = await withGitFacts(() => commitWork(root, item, loadConfig(root), ['src/runner-result.txt']));
console.log(JSON.stringify(result));`;
  const env = { ...box.env, PULLBOARD_TEST_ITEM: JSON.stringify(item) };
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.worker, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const committed = JSON.parse(result.stdout.trim());
  assert.equal(committed.ok, true, committed.output);
  assert.notEqual(committed.commit, before, 'the runner reports the HEAD created by its commit');
  assert.equal(committed.commit, box.git(box.worker, 'rev-parse', 'HEAD'));
});

test('cli.journeys-init-calls-head.settled-and-concurrent-commands-do-not: settled and concurrent commands do not share Git-fact caches [C7]', async (t) => {
  const box = await fixture(t);
  const settledRead = deferred();
  const releaseSettled = deferred();
  const settledAgain = deferred();
  let delayed;
  await withGitFacts(async () => {
    const initial = headCommit(box.repo);
    delayed = (async () => {
      await releaseSettled.promise;
      const first = headCommit(box.repo);
      settledRead.resolve(first);
      await settledAgain.promise;
      return headCommit(box.repo);
    })();
    assert.equal(headCommit(box.repo), initial, 'facts are reused while this command remains active');
  });
  const firstCommit = advanceHead(box, 'expire command cache one');
  releaseSettled.resolve();
  assert.equal(await settledRead.promise, firstCommit, 'a callback inherited from a settled command reads fresh Git state');
  const secondCommit = advanceHead(box, 'expire command cache two');
  settledAgain.resolve();
  assert.equal(await delayed, secondCommit, 'the expired callback does not retain its first late read');

  const aRead = deferred();
  const releaseA = deferred();
  const bRead = deferred();
  const releaseB = deferred();
  const a = withGitFacts(async () => {
    const first = headCommit(box.repo);
    aRead.resolve();
    await releaseA.promise;
    return [first, headCommit(box.repo)];
  });
  await aRead.promise;
  const thirdCommit = advanceHead(box, 'concurrent command cache one');
  const b = withGitFacts(async () => {
    const first = headCommit(box.repo);
    bRead.resolve();
    await releaseB.promise;
    return [first, headCommit(box.repo)];
  });
  await bRead.promise;
  const fourthCommit = advanceHead(box, 'concurrent command cache two');
  releaseA.resolve();
  releaseB.resolve();
  assert.deepEqual(await a, [secondCommit, secondCommit], 'one active command keeps its own fact values');
  assert.deepEqual(await b, [thirdCommit, thirdCommit], 'a concurrent command has a separate fact scope');
  assert.equal(headCommit(box.repo), fourthCommit, 'outside a command scope Git facts are read directly');
});
