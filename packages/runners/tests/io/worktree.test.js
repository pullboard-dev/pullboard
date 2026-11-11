/** Runner-hosted item folders: the folder, git and hooks run on the runner over SSH; the coordinator repository gets no worktree [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryRepository } from '../../../../apps/cli/tests/fixtures/board/submit.js';
import { temporaryDirectory } from '../../../../apps/cli/tests/fixtures/board.js';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { createHostedItemFolder } from '../../index.js';
import { hostedItemFolderPath } from '../../index.js';
import { returnHostedBranch } from '../../index.js';
import { runInHostedItemFolder } from '../../index.js';

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
