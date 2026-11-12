/** Runner-hosted item folders: the folder, git and hooks run on the runner over SSH; the coordinator repository gets no worktree [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { temporaryRepository } from '../../../../apps/cli/tests/fixtures/board/submit.js';
import { temporaryDirectory } from '../../../../apps/cli/tests/fixtures/board.js';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { createHostedItemFolder } from '../../index.js';
import { hostedItemFolderPath } from '../../index.js';
import { returnHostedBranch } from '../../index.js';
import { runInHostedItemFolder } from '../../index.js';
import { cachedTrunkPack } from '../../src/io/worktree.js';
import { checkoutCandidate } from '../../../drive/index.js';
import { boardEndpoint } from '../../../drive/index.js';
import { boardTrunkPack } from '../../../drive/src/io/pull.js';
import { createApiHandler } from '../../../api/index.js';
import { servedTrunkPack } from '../../index.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';

const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];

/**
 * Run git in a fixture directory without a synchronous child.
 * @param {string} cwd The repository directory.
 * @param {...string} args Git arguments.
 * @returns {Promise<string>} Trimmed standard output.
 */
async function git(cwd, ...args) {
  const run = await runFixtureChildAsync('git', [...IDENTITY, ...args], { cwd });
  assert.equal(run.failure, null, run.context);
  return run.stdout.trim();
}

/**
 * Write an `ssh` stand-in that logs the destination host and runs the remote command from the runner's home.
 * @param {string} directory Where the stand-in lives.
 * @param {string} runnerHome The directory standing in for the runner user's home.
 * @param {string} log The file that records each destination host.
 * @returns {string} The stand-in's path.
 */
function fakeSsh(directory, runnerHome, log) {
  const path = join(directory, 'ssh');
  writeFileSync(path, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nprintf '%s\\n' "$1" >> '${log}'\nshift\ncd '${runnerHome}' && exec /bin/sh -c "$1"\n`);
  chmodSync(path, 0o755);
  return path;
}

test('clause 1: a claimed item folder is created on the registered runner over ssh; git and the pre-commit hook run there and the branch returns to the coordinator with no coordinator worktree [C7]', async t => {
  const coordinator = temporaryRepository(t, 'pullboard-hosted-coordinator-');
  const scratch = temporaryDirectory('pullboard-hosted-runner-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const runnerHome = join(scratch, 'home');
  mkdirSync(runnerHome);
  const log = join(scratch, 'ssh.log');
  const ssh = fakeSsh(scratch, runnerHome, log);
  mkdirSync(join(coordinator, '.githooks'));
  writeFileSync(join(coordinator, '.githooks', 'pre-commit'), '#!/bin/sh\npwd > .hook-ran\n');
  chmodSync(join(coordinator, '.githooks', 'pre-commit'), 0o755);
  await git(coordinator, 'add', '.githooks/pre-commit');
  await git(coordinator, 'commit', '-q', '-m', 'hooks');
  const mainHead = await git(coordinator, 'rev-parse', 'main');
  const worktreesBefore = await git(coordinator, 'worktree', 'list', '--porcelain');

  const runner = { host: 'runner-a', builderRoot: 'builders' };
  const hosted = await createHostedItemFolder(runner, { itemId: 3538, origin: coordinator, branch: 'core/item-3538', hooksPath: '.githooks' }, { ssh });
  assert.deepEqual(hosted, { host: 'runner-a', folder: 'builders/item-3538', head: mainHead });
  const runnerFolder = join(runnerHome, 'builders', 'item-3538');
  assert.ok(existsSync(join(runnerFolder, 'pullboard.json')), 'the item folder is checked out on the runner');
  assert.equal(await git(runnerFolder, 'branch', '--show-current'), 'core/item-3538');

  const wrote = await runInHostedItemFolder(runner, hosted.folder, ['/bin/sh', '-c', 'echo built > work.txt && git add work.txt'], { ssh });
  assert.equal(wrote.status, 0, wrote.stderr);
  const committed = await runInHostedItemFolder(runner, hosted.folder, ['git', ...IDENTITY, 'commit', '-q', '-m', 'work'], { ssh });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(readFileSync(join(runnerFolder, '.hook-ran'), 'utf8').trim(), /builders\/item-3538$/u, 'the pre-commit hook ran in the runner folder');
  assert.equal(existsSync(join(coordinator, '.hook-ran')), false, 'no hook ran in the coordinator checkout');

  const returned = await returnHostedBranch(runner, hosted.folder, 'core/item-3538', { ssh });
  assert.equal(returned.status, 0, returned.stderr);
  const runnerHead = await git(runnerFolder, 'rev-parse', 'HEAD');
  assert.notEqual(runnerHead, mainHead);
  assert.equal(await git(coordinator, 'rev-parse', 'core/item-3538'), runnerHead, 'the coordinator reads the commit the runner built');
  assert.equal(await git(coordinator, 'worktree', 'list', '--porcelain'), worktreesBefore, 'the coordinator repository gained no item worktree');

  const renewed = await createHostedItemFolder(runner, { itemId: 3538, origin: coordinator, branch: 'core/item-3538', hooksPath: '.githooks' }, { ssh });
  assert.equal(renewed.head, runnerHead, 'a renewed claim continues the runner folder instead of resetting it');
  const hosts = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(hosts.length, 5);
  assert.ok(hosts.every(host => host === 'runner-a'), 'every folder, git and hook step went over ssh to the runner');
});

test('a runner-hosted folder refuses an unregistered host, a non-item id and a ref that leaves the item branch [C7]', async () => {
  assert.equal(hostedItemFolderPath({ host: 'runner-a' }, 7), '.pullboard-runner/builders/item-7');
  assert.throws(() => hostedItemFolderPath({ host: 'bad host' }, 7), /registered runner host/u);
  assert.throws(() => hostedItemFolderPath({ host: 'runner-a' }, '../7'), /item number/u);
  assert.throws(() => hostedItemFolderPath({ host: 'runner-a', builderRoot: '../escape' }, 7), /builder root/u);
  await assert.rejects(createHostedItemFolder({ host: 'runner-a' }, { itemId: 7, origin: '/repo', branch: '../main' }), /refuses ref/u);
});

test('#5932 clause 1: three pulled jobs fetching one trunk commit at once share one cached pack build on the coordinator [C7]', async t => {
  const trunk = temporaryRepository(t, 'pullboard-trunk-pack-');
  const scratch = temporaryDirectory('pullboard-trunk-pack-runners-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await git(trunk, 'tag', '-a', 'v0.0.1', '-m', 'release');
  const commit = await git(trunk, 'rev-parse', 'main');
  let builds = 0, asked = 0;
  const pack = async wanted => {
    asked += 1;
    const served = await cachedTrunkPack(trunk, wanted, { dir: join(scratch, 'packs') });
    if (served.built) builds += 1;
    return served;
  };
  const caches = ['a', 'b', 'c'].map(name => join(scratch, name));
  const checkouts = await Promise.all(caches.map(cache => checkoutCandidate(cache, trunk, commit, 'job', [], { main: commit, pack })));
  for (const checkout of checkouts) assert.equal(checkout.ok, true, checkout.reason);
  assert.equal(asked, 3, 'every cold runner asked for the shared pack');
  assert.equal(builds, 1, 'three concurrent fetchers of one commit ran pack-objects once');
  for (const checkout of checkouts) {
    assert.equal(await git(checkout.folder, 'rev-parse', 'HEAD'), commit);
    assert.equal(await git(checkout.folder, 'rev-parse', 'v0.0.1^{commit}'), commit, 'release tags still reach the checkout');
  }
});

test('#5932 clause 2: a runner that already has the commit fetches nothing new, and a warm runner never downloads a whole-history pack [C7]', async t => {
  const trunk = temporaryRepository(t, 'pullboard-trunk-warm-');
  const scratch = temporaryDirectory('pullboard-trunk-warm-runner-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const cache = join(scratch, 'cache');
  const first = await git(trunk, 'rev-parse', 'main');
  assert.equal((await checkoutCandidate(cache, trunk, first, 'job', [], { main: first })).ok, true);
  let asked = 0;
  const pack = async () => { asked += 1; return null; };
  const store = join(cache, 'git');
  const refsBefore = await git(store, 'for-each-ref');
  const again = await checkoutCandidate(cache, join(scratch, 'no-such-trunk'), first, 'job', [], { main: first, pack });
  assert.equal(again.ok, true, again.reason);
  assert.equal(await git(store, 'for-each-ref'), refsBefore, 'a commit the runner holds fetches nothing, from a trunk it cannot even reach');
  writeFileSync(join(trunk, 'next.txt'), 'next\n');
  await git(trunk, 'add', 'next.txt');
  await git(trunk, 'commit', '-q', '-m', 'next');
  const second = await git(trunk, 'rev-parse', 'main');
  assert.equal((await checkoutCandidate(cache, trunk, second, 'job', [], { main: second, pack })).ok, true);
  assert.equal(asked, 0, 'a warm store fetches the new commit incrementally and never asks for the shared pack');
});

test('#5945 clause 1: the board serves GET /trunk/<commit>.pack from one shared build, 404 for an unknown commit, and refuses a non-hex id; cold runners fetch through it [C7]', async t => {
  const trunk = temporaryRepository(t, 'pullboard-trunk-route-');
  const scratch = temporaryDirectory('pullboard-trunk-route-runners-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const commit = await git(trunk, 'rev-parse', 'main');
  let builds = 0, served = 0;
  // The local adapter's port as pullboard serve wires it: the board's checkout, packs under a scratch folder.
  const handler = createApiHandler({ refusalDocument: error => ({ error: { code: error.code, message: String(error.message) } }),
    authenticate: req => { if (req.headers['x-pullboard-key'] !== 'fixture-key') throw Object.assign(new Error('key'), { code: 'AUTH_REQUIRED' }); return { local: true }; },
    board: id => ({ id, root: trunk }),
    trunkPack: async (board, wanted) => {
      const pack = await servedTrunkPack(board.root, wanted, { dir: join(scratch, 'packs') });
      if (pack?.built) builds += 1;
      if (pack) served += 1;
      return pack;
    } });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const board = `http://127.0.0.1:${server.address().port}/api/v1/boards/fixture`;
  const endpoint = boardEndpoint(`${board}?k=fixture-key`);
  const checkouts = await Promise.all(['a', 'b', 'c'].map(name => checkoutCandidate(join(scratch, name), trunk, commit, 'job', [],
    { main: commit, pack: boardTrunkPack(endpoint, fetchFresh, join(scratch, name, 'packs')) })));
  for (const checkout of checkouts) {
    assert.equal(checkout.ok, true, checkout.reason);
    assert.equal(await git(checkout.folder, 'rev-parse', 'HEAD'), commit);
    assert.ok(existsSync(join(scratch, checkout.folder.slice(scratch.length + 1).split('/')[0], 'packs', `trunk-${commit}.pack`)), 'each cold runner downloaded the board pack');
  }
  assert.equal(served, 3, 'every cold runner was served the pack over GET /trunk/<commit>.pack');
  assert.equal(builds, 1, 'three concurrent GETs of one commit shared one pack-objects build');
  const unknown = await fetchFresh(`${board}/trunk/${'0'.repeat(40)}.pack`, { headers: { 'x-pullboard-key': 'fixture-key' } });
  assert.deepEqual([unknown.status, (await unknown.json()).error.code], [404, 'NO_COMMIT']);
  assert.equal(await boardTrunkPack(endpoint, fetchFresh, join(scratch, 'd'))('0'.repeat(40)), null, 'a runner reads the 404 as no pack and fetches instead');
  const bad = await fetchFresh(`${board}/trunk/main.pack`, { headers: { 'x-pullboard-key': 'fixture-key' } });
  assert.deepEqual([bad.status, (await bad.json()).error.code], [400, 'BAD_REQUEST']);
  const keyless = await fetchFresh(`${board}/trunk/${commit}.pack`);
  assert.equal(keyless.status, 401, 'the pack is served only with the board key');
  await keyless.body?.cancel();
});
