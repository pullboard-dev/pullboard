/** A runner gate fetches a claim base outside its checkout from the trunk remote; one the remote lacks refuses once [P7,C7,#5808]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { sharedRemoteAnalysis } from '../../../../src/io/submit/gate.js';
import { submitUntilSettled } from '../../../../../../packages/gate/index.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { runFixtureGit } from '../../../fixtures/child.js';

/** The real lane-ownership check, which accepted main's stand-in sandbox re-exports into the runner job. */
const SANDBOX = new URL('../../../../../../packages/sandbox/index.js', import.meta.url).href;

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  delete env.PULLBOARD_TRUNK_REMOTE;
  return env;
}

/**
 * A trunk remote whose accepted main carries stand-in tooling and the real sandbox check, another item's branch
 * holding the claim base, a candidate built on main, and a runner checkout fetched with only main and the candidate,
 * as a job checkout is. `claim` is 'branch' (the base is on core/item-5658) or 'absent' (no remote has it).
 */
function fixture(t, { claim = 'branch' } = {}) {
  const dir = temporaryDirectory('submit-claim-fetch-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), trunk = temporaryRepository(t, 'submit-claim-fetch-trunk-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (root, path, body) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  const commit = (root, message) => { git(root, 'add', '.'); git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message); return git(root, 'rev-parse', 'HEAD'); };
  git(trunk, 'config', 'pullboard.trunk', 'refs/heads/main');
  put(trunk, 'pullboard.json', JSON.stringify({ lanes: { core: { owns: ['src/'] }, docs: { owns: ['docs/'] } } }) + '\n');
  put(trunk, 'package.json', '{"type":"module"}\n');
  put(trunk, 'packages/items/index.js', 'export function requirePlannedSource() {}\nexport function requireSubmitComposition() {}\n');
  put(trunk, 'packages/gate/index.js', 'export async function submitGatePlan() { return { proofFiles: [] }; }\n');
  put(trunk, 'packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put(trunk, 'bin/cells-submit-checks.js', 'export async function requireSubmitCells() { return {}; }\n');
  put(trunk, 'packages/codemap/src/io/cells/scripts/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put(trunk, 'packages/sandbox/index.js', `export { submissionPaths } from ${JSON.stringify(SANDBOX)};\n`);
  const main = commit(trunk, 'main');
  // Another item's commit, on its own branch only: the claim base #5660 met on #5658's branch.
  git(trunk, 'checkout', '--quiet', '-b', 'core/item-5658');
  put(trunk, 'src/other.js', 'export const other = 1;\n');
  const branchHead = commit(trunk, 'item 5658');
  git(trunk, 'checkout', '--quiet', 'main');
  git(trunk, 'checkout', '--quiet', '-b', 'core/item-5660');
  put(trunk, 'src/thing.js', 'export const thing = 1;\n');
  const source = commit(trunk, 'candidate');
  git(trunk, 'checkout', '--quiet', 'main');
  git(trunk, 'update-ref', 'refs/pullboard/gate/5660', source);
  let base = branchHead;
  // A commit made in a repository the trunk remote never heard of.
  if (claim === 'absent') base = git(temporaryRepository(t, 'submit-claim-fetch-elsewhere-'), 'rev-parse', 'HEAD');
  // --no-local copies only what main reaches, never the trunk's whole object store.
  git(dir, 'clone', '--quiet', '--no-local', '--no-checkout', '--single-branch', '--branch', 'main', '--no-tags', trunk, runner);
  git(runner, 'fetch', '--quiet', '--no-tags', trunk, 'refs/pullboard/gate/5660:refs/pullboard/gate/5660');
  git(runner, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
  return { trunk, runner, main, source, base, env, tree: git(trunk, 'rev-parse', `${source}^{tree}`), dir, git };
}

/** An injected runner transport that runs each request in the runner checkout and counts the runner jobs it starts. */
function countingRunner(box, env = box.env) {
  const counts = { jobs: 0 };
  const runOnRunnerAsync = async (_root, shell, options) => {
    counts.jobs++;
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  return { counts, lease: { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } } };
}

/** The queued submit's authorization part, read from one runner analysis job as submit.js asks for it. */
function authorize(box, runner, { trunkRemote = box.trunk } = {}) {
  const item = { item_id: 5660, item_lane: 'core', item_claim_head: box.base, item_frozen: null };
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.base, check: '', criterion: 'c', composition: null, staticChecks: '',
    config: {}, readCutItems: () => [], perPart: true, parts: ['authorization'], authorization: { item }, trunkRemote };
  const read = sharedRemoteAnalysis(() => remoteSubmitAnalysis(box.trunk, request, runner.lease, join(box.dir, 'artifacts')));
  return read('authorization', new AbortController().signal);
}

/** Whether the runner checkout holds a commit's objects. */
function holds(box, commit) {
  try { box.git(box.runner, 'cat-file', '-e', `${commit}^{commit}`); return true; } catch { return false; }
}

test('clause 1: a runner gate fetches a claim base found only on another item\'s branch and passes lane ownership on the runner [P7,C7]', async t => {
  const box = fixture(t);
  assert.equal(holds(box, box.base), false, 'the job checkout starts with only main and the candidate, as the #5660 reproduction did');
  const { submissionPaths } = await import(SANDBOX);
  assert.throws(() => submissionPaths(box.runner, { item_id: 5660, item_lane: 'core', item_claim_head: box.base, item_frozen: null }, box.source, { mainCommit: box.main }),
    { code: 'NO_POLICY' }, 'without the fetch the lane check refuses NO_POLICY, the reported fault');
  const runner = countingRunner(box);
  const analysis = await authorize(box, runner);
  assert.deepEqual(analysis.authorization, { paths: ['src/thing.js'], mechanical: [], ownership: null }, 'the runner checked lane ownership and found the core path owned');
  assert.equal(runner.counts.jobs, 1, 'one runner job, no rerun');
  assert.equal(holds(box, box.base), true, 'the claim base came into the runner checkout from the trunk remote');
});

test('clause 1: a pulled job reads its trunk remote from the runner, so the same fetch serves the pull path [P7,C7]', async t => {
  const box = fixture(t);
  const runner = countingRunner(box, { ...box.env, PULLBOARD_TRUNK_REMOTE: box.trunk });
  const analysis = await authorize(box, runner, { trunkRemote: '' });
  assert.deepEqual(analysis.authorization, { paths: ['src/thing.js'], mechanical: [], ownership: null });
  assert.equal(holds(box, box.base), true);
});

test('clause 2: a claim base the trunk remote lacks refuses NO_POLICY once with a next step, never an infrastructure rerun [P7,C7]', async t => {
  const box = fixture(t, { claim: 'absent' });
  const runner = countingRunner(box);
  const notices = [];
  const settled = submitUntilSettled(() => authorize(box, runner), { healthy: async () => true, wait: async () => {}, say: line => notices.push(line) });
  await assert.rejects(settled, error => {
    assert.equal(error.code, 'NO_POLICY');
    assert.match(error.message, new RegExp(`${box.base.slice(0, 12)} is not on the trunk remote`, 'u'));
    assert.match(error.next, /push that commit to the trunk remote/u, 'the refusal names its next step');
    assert.equal(error.rerun, false);
    return true;
  });
  assert.equal(runner.counts.jobs, 1, 'the refusal is recorded once: no second runner job');
  assert.deepEqual(notices, [], 'no infrastructure rerun notice');
});
