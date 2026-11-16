/** Two verify --compare launches at one tooling share one tools folder and copy nothing the second time [C7]. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../fixtures/board.js';
import { temporaryRepository } from '../../fixtures/board/submit.js';
import { copyTools } from '../../../src/io/toolsnapshot.js';
import { toolsSnapshot } from '../../../src/io/toolsnapshot.js';
import { existsSync } from 'node:fs';
import { sharedToolsTarget } from '../../../src/io/toolsnapshot.js';
import { launchComparisonWorker } from '../../../../../packages/verify/index.js';
import { prepareComparison } from '../../../../../packages/verify/index.js';

/**
 * Run git in a folder with no user config.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/**
 * A private temp dir that tmpdir() resolves to, and a small committed kit repository with tooling folders.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ temp: string, repo: string, common: string }}
 */
function sandbox(t) {
  const temp = realpathSync(temporaryDirectory('pullboard-compare-share-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const repo = temporaryRepository(t, 'pullboard-compare-share-repo-');
  for (const dir of ['bin', 'apps', 'packages', 'src']) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'a.js'), `export const ${dir} = 1;\n`);
  }
  writeFileSync(join(repo, 'package.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tools');
  const common = join(temp, 'common');
  mkdirSync(common, { recursive: true });
  return { temp, repo, common };
}

/**
 * A stand-in for the detached worker spawn: it records the tools folder it was pointed at and reports a pid.
 *
 * @param {string[]} launched
 * @returns {Function}
 */
function fakeSpawn(launched) {
  return (_execPath, [script]) => {
    launched.push(script);
    const worker = new EventEmitter();
    worker.pid = 4242;
    worker.unref = () => {};
    process.nextTick(() => worker.emit('spawn'));
    return worker;
  };
}

test('clause 1: two comparisons at the same tooling share one tools folder and the second copies no files [C7]', async t => {
  const { temp, repo, common } = sandbox(t);
  let copies = 0;
  const snapshot = (root, job, dir) => toolsSnapshot(root, job, dir, { copy: (from, to) => { copies += 1; copyTools(from, to); } });
  const launched = [];
  const request = { origin: repo, commonDir: common, toolRoot: repo, entry: 'apps/cli/pullboard.js', item: 1, source: 'abc', digest: 'def' };
  const first = await launchComparisonWorker(request, { snapshot, spawnWorker: fakeSpawn(launched) });
  assert.equal(copies, 1, 'the first comparison copies the tools once');
  const second = await launchComparisonWorker(request, { snapshot, spawnWorker: fakeSpawn(launched) });
  assert.equal(copies, 1, 'the second comparison at the same tooling performs no copy');
  assert.notEqual(first.job, second.job);
  const folders = readdirSync(temp).filter(name => /^pullboard-handoff-tools-[0-9a-f]{40}$/u.test(name));
  assert.equal(folders.length, 1, 'one shared folder');
  assert.equal(launched.length, 2);
  const toolsOf = job => JSON.parse(readFileSync(join(common, 'pullboard', 'review-comparisons', job, 'request.json'), 'utf8')).tools;
  assert.equal(toolsOf(first.job), join(temp, folders[0]), 'the first request names the shared folder');
  assert.equal(toolsOf(second.job), toolsOf(first.job), 'both requests name the same tools folder');
  assert.equal(readdirSync(join(temp, folders[0])).includes('bin'), true, 'the folder is not removed at launch');
});

test('clause 1: a cold comparison snapshot is built by the detached worker from the pinned commit, so launch copies nothing [C7]', async t => {
  const { temp, repo, common } = sandbox(t);
  let copies = 0;
  const snapshot = (root, job, dir) => toolsSnapshot(root, job, dir, { copy: (from, to) => { copies += 1; copyTools(from, to); } });
  const launched = [];
  const request = { origin: repo, commonDir: common, toolRoot: repo, entry: 'apps/cli/pullboard.js', item: 1, source: 'abc', digest: 'def' };
  const snapshotModule = new URL('../../../src/io/toolsnapshot.js', import.meta.url).href;
  const { job } = await launchComparisonWorker(request, { snapshot, plan: sharedToolsTarget, snapshotModule, spawnWorker: fakeSpawn(launched) });
  assert.equal(copies, 0, 'launch returns before any copy');
  const target = sharedToolsTarget(repo);
  assert.equal(existsSync(target.tools), false, 'the shared folder is not built at launch');
  const requestFile = join(common, 'pullboard', 'review-comparisons', job, 'request.json');
  const recorded = JSON.parse(readFileSync(requestFile, 'utf8'));
  assert.equal(recorded.tools, target.tools, 'the request names the shared folder');
  assert.equal(recorded.toolsCommit, git(repo, 'rev-parse', 'HEAD'), 'the request pins the commit taken at launch');
  writeFileSync(join(repo, 'bin/a.js'), 'export const changed = 1;\n');
  git(repo, 'commit', '-qam', 'branch moved after launch');
  const runs = [];
  await prepareComparison(requestFile, { runTools: async args => { runs.push(args); return { status: 0 }; } });
  assert.equal(readFileSync(join(target.tools, 'bin/a.js'), 'utf8'), 'export const bin = 1;\n', 'the worker builds the pinned commit, not the moved checkout');
  assert.equal(runs.length, 1, 'the comparison then runs once');
  assert.match(runs[0][0], /comparison\.js$/u, 'the run is the comparison worker, named under the built shared folder');
  assert.equal(runs[0][1], requestFile);
  assert.equal(readdirSync(temp).filter(name => /^pullboard-handoff-tools-[0-9a-f]{40}$/u.test(name)).length, 1, 'one shared folder');
});
