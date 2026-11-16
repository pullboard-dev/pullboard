/** Real private Git caches preserve job roots while bounded candidate references fall [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { pinSourceCacheJob } from '../../../../packages/runners/index.js';
import { pruneSourceCache } from '../../../../packages/runners/index.js';
import { SOURCE_CACHE_CANDIDATES } from '../../../../packages/runners/index.js';
import { HOST } from '../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../cli/tests/fixtures/runner/ssh.js';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each sandbox's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

/** Execute actual private Git with complete diagnostics and normal fixture isolation. */
function git(root, args, input) {
  return runFixtureGit(args, { cwd: root, input, encoding: 'utf8' });
}

/** Import a deterministic real commit chain, not cache/proof records or operational history. */
function history(root, count) {
  const config = '{"gate":"true"}\n';
  let stream = `blob\nmark :1\ndata ${Buffer.byteLength(config)}\n${config}\n`;
  for (let index = 0; index < count; index++) {
    const message = `private cache graph ${index}\n`;
    stream += `commit refs/heads/main\nmark :${index + 2}\ncommitter Fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}`;
    if (index) stream += `from :${index + 1}\n`;
    stream += 'M 100644 :1 pullboard.json\n\n';
  }
  git(root, ['fast-import', '--quiet'], stream + 'done\n');
  return git(root, ['rev-list', '--reverse', 'main']).split('\n');
}

/** Acquire the same native source-cache resource in an isolated machine pool, restoring the caller environment. */
async function cacheLease(root, repoId, onWait) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'cache', 'resource-pool');
  try {
    return await takeResource({ name: `repo-${repoId}`, capacity: 1, scope: 'machine', root,
      repo: root, agent: `private-cache-${Math.random()}`, kind: 'source-cache', onWait });
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
}

/** Build a real bare cache plus private job directory and return an actually held native cache lease. */
async function fixture(t, count = 8) {
  const box = cellSandbox(owner), runnerRoot = join(box.dir, 'runner'), cache = join(box.dir, 'cache.git');
  mkdirSync(join(runnerRoot, 'jobs'), { recursive: true });
  git(box.dir, ['init', '--bare', '-q', cache]);
  const commits = history(cache, count), repoId = createHash('sha256').update(cache).digest('hex');
  git(cache, ['update-ref', '--stdin'], commits.map(head => `update refs/pullboard/candidates/${head} ${head}`).join('\n') + '\n');
  const lease = await cacheLease(runnerRoot, repoId);
  t.after(() => lease.release());
  /** Use the actual private Git adapter while retaining the production asynchronous transport interface. */
  const nativeGit = async (root, args, env, input) => git(root, args, input);
  return { box, runnerRoot, cache, commits, repoId, lease, git: nativeGit };
}

test('legacy bootstrap uses declared commit-date order, with held/published roots and complete objects retained [C7]', async (t) => {
  const box = await fixture(t), held = box.commits[0], published = box.commits[1], requested = box.commits.at(-1);
  const job = join(box.runnerRoot, 'jobs', 'held');
  mkdirSync(job);
  pinSourceCacheJob(job, { repoId: box.repoId, commit: held });
  git(box.cache, ['update-ref', `refs/pullboard/published/${published}`, published]);
  const inventory = new Map([['stale caller entry', requested]]);
  const result = await pruneSourceCache({ ...box, roots: [requested], limit: 4, inventory });
  assert.deepEqual([...inventory].sort(), git(box.cache, ['for-each-ref', '--format=%(refname) %(objectname)',
    'refs/pullboard/candidates', 'refs/pullboard/published']).split('\n').map(line => line.split(' ')).sort(),
  'the output inventory replaces caller entries with actual retained Git refs, including published refs');
  for (const ref of result.pruned) assert.equal(inventory.has(ref), false, 'deleted refs are never announced');
  assert.equal(result.retained, 6);
  assert.equal(result.protected, 3);
  assert.match(result.bootstrapOrder, /not observed last use/u);
  for (const head of [held, published, requested, box.commits.at(-2)]) {
    assert.equal(git(box.cache, ['rev-parse', `refs/pullboard/candidates/${head}`]), head);
  }
  assert.equal(git(box.cache, ['rev-parse', `refs/pullboard/published/${published}`]), published);
  for (const head of box.commits) assert.equal(git(box.cache, ['cat-file', '-t', head]), 'commit', 'pruning never removes committed objects');
  assert.equal(JSON.parse(readFileSync(join(box.cache, 'pullboard-pruned-refs.jsonl'), 'utf8').trim()).pruned.length, 2);
  rmSync(job, { recursive: true });
  await pruneSourceCache({ ...box, roots: [held], limit: 4 });
  const observed = await pruneSourceCache({ ...box, roots: [requested], limit: 3 });
  assert.equal(observed.retained, 4);
  assert.equal(git(box.cache, ['rev-parse', `refs/pullboard/candidates/${held}`]), held, 'observed use outranks a newer legacy commit after bootstrap');
  await pruneSourceCache({ ...box, roots: [box.commits.at(-2)], limit: 3 });
  const next = await pruneSourceCache({ ...box, roots: [requested], limit: 2 });
  assert.equal(next.retained, 3);
  assert.ok(next.pruned.includes(`refs/pullboard/candidates/${held}`), 'a completed job no longer pins its old ref');
});

test('legacy leftovers cannot veto pruning, while every current spec root survives in addition to newest refs [C7]', async (t) => {
  const box = await fixture(t, 8), jobs = join(box.runnerRoot, 'jobs');
  const legacy = join(jobs, 'old-unpinned'), invalid = join(jobs, 'old-invalid'), held = join(jobs, 'held');
  for (const directory of [legacy, invalid, held]) mkdirSync(directory);
  writeFileSync(join(legacy, 'diagnostic.log'), 'retained worker diagnostics');
  writeFileSync(join(invalid, 'source-cache-pin.json'), '{not valid');
  pinSourceCacheJob(held, { repoId: box.repoId, commit: box.commits[0], trunk: { commit: box.commits[1] },
    trustedMode: { policyCommit: box.commits[2], trunk: { commit: box.commits[3] } } });
  const result = await pruneSourceCache({ ...box, roots: [box.commits.at(-1)], limit: 2 });
  assert.equal(result.unknownPins, true, 'legacy and invalid metadata remain visible');
  assert.equal(result.protected, 5);
  assert.equal(result.retained, 6, 'newest two PLUS four older current-spec roots');
  assert.equal(result.pruned.length, 2, 'old folders do not disable pruning');
  assert.equal(result.overage, 4);
  for (const head of [...box.commits.slice(0, 4), ...box.commits.slice(-2)]) {
    assert.equal(git(box.cache, ['rev-parse', `refs/pullboard/candidates/${head}`]), head);
  }
  for (const head of box.commits.slice(4, 6)) assert.ok(result.pruned.includes(`refs/pullboard/candidates/${head}`));
  assert.equal(readFileSync(join(legacy, 'diagnostic.log'), 'utf8'), 'retained worker diagnostics', 'no orphan cleanup');
  rmSync(held, { recursive: true });
  const completed = await pruneSourceCache({ ...box, roots: [box.commits.at(-1)], limit: 2 });
  assert.equal(completed.retained, 2, 'finished job roots lose protection without proving orphan death');
  assert.equal(completed.pruned.length, 4);
  assert.equal(SOURCE_CACHE_CANDIDATES, 300, 'protected roots do not alter the default bound');
  const requested = box.commits.at(-1), inventory = new Map();
  git(box.cache, ['update-ref', '-d', `refs/pullboard/candidates/${requested}`]);
  await pruneSourceCache({ ...box, roots: [requested], limit: 2, inventory });
  assert.equal(inventory.has(`refs/pullboard/candidates/${requested}`), false,
    'a requested root without a Git ref is not invented in the negotiation inventory');
});

test('native cache lease serializes peers and Git CAS refuses a changed ref without partial pruning [C7]', async (t) => {
  const box = await fixture(t, 6);
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  let acquired = false;
  const peer = cacheLease(box.runnerRoot, box.repoId, () => notify()).then(lease => { acquired = true; return lease; });
  await waiting;
  assert.equal(acquired, false, 'a second cache owner waits behind the native lease');
  box.lease.release();
  const lease = await peer;
  t.after(() => lease.release());
  let changed = false;
  /** Inject a real competing ref mutation exactly before Git checks the planned CAS transaction. */
  const conflictingGit = async (root, args, env, input) => {
    if (args[0] === 'update-ref' && args[1] === '--stdin' && input.startsWith('start\n')) {
      const [name] = input.split('\n')[1].slice('delete '.length).split(' ');
      git(root, ['update-ref', name, box.commits.at(-1)]);
      changed = true;
    }
    return runFixtureGit(args, { cwd: root, input, encoding: 'utf8' });
  };
  await assert.rejects(pruneSourceCache({ ...box, lease, roots: [box.commits.at(-1)], limit: 2, git: conflictingGit }), /cannot lock ref|expected/u);
  assert.equal(changed, true);
  assert.equal(git(box.cache, ['for-each-ref', '--format=%(refname)', 'refs/pullboard/candidates']).split('\n').length, box.commits.length);
});

/** Wait for an actual child-created marker; the timeout is solely a failure hang ceiling. */
function marker(file, completion) {
  if (existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(join(file, '..'), () => { if (existsSync(file)) done(); });
    const timeout = setTimeout(() => done(new Error('private runner marker was not created')), 60000);
    /** Close both owned wait handles after the real marker or a failed child. */
    function done(error) { clearTimeout(timeout); watcher.close(); if (error) reject(error); else resolve(); }
    completion.then(() => { if (!existsSync(file)) done(new Error('private runner completed without its source marker')); }, done);
    if (existsSync(file)) done();
  });
}

test('a real worker runs beyond 1024 legacy refs while another live job keeps its candidate [C7]', { skip: 'CONTROLLER_ONLY: deleted with #7526 (SSH stand-in runner dispatch via runOnRunnerAsync; a pulled runner job never starts the stand-in worker)' }, async () => {
  const box = cellSandbox(owner), repo = join(box.dir, 'source'), home = join(box.dir, 'home');
  const bin = join(box.dir, 'bin'), worker = join(box.dir, 'worker'), machine = join(box.dir, 'machine');
  for (const directory of [repo, home, bin, worker, machine]) mkdirSync(directory, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  const commits = history(repo, 1030);
  git(repo, ['checkout', '-q', 'main', '--', '.']);
  const requests = join(box.dir, 'requests'), stderr = join(box.dir, 'worker.stderr');
  installSshStandIn({ bin, worker, home, machineHome: machine, requests, stderrLog: stderr });
  const started = join(box.dir, 'started'), release = join(box.dir, 'release');
  const command = `node --input-type=module -e ${JSON.stringify(`import fs from 'node:fs';import cp from 'node:child_process';const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();fs.writeFileSync(${JSON.stringify(started)},head);while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,25));console.log('SOURCE_HEAD:'+head)`)}`;
  /** Dispatch through the real controller, work spec, native worker and source scanner in private fixture storage. */
  async function execute(command, expected) {
    const source = `import {runOnRunnerAsync} from ${JSON.stringify(new URL('../../../../packages/runners/index.js', import.meta.url).href)};const result=await runOnRunnerAsync(process.cwd(),${JSON.stringify(command)},{runner:{host:${JSON.stringify(HOST)},slots:2,browser:1},metadata:{item:'fixture',kind:'remote-command'}});console.log(JSON.stringify({green:result.isGreen,output:result.output}));`;
    const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repo, env: { ...box.env, PATH: `${bin}:${box.env.PATH}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.context}\n${result.stdout}`);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(parsed.green, true, parsed.output);
    assert.ok(parsed.output.includes('SOURCE_HEAD:' + expected), parsed.output);
    return parsed;
  }
  const showHead = "node -e \"console.log('SOURCE_HEAD:'+require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())\"";
  await execute(showHead, commits.at(-1));
  git(repo, ['checkout', '-q', '--detach', commits[0]]);
  const held = execute(command, commits[0]);
  try {
    await marker(started, held);
    assert.equal(readFileSync(started, 'utf8'), commits[0], 'the first real worker holds the old exact source');
    const runnerRoot = join(home, '.pullboard-runner');
    const repoId = createHash('sha256').update(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).digest('hex');
    const cache = join(runnerRoot, 'repos', `${repoId}.git`), lease = await cacheLease(runnerRoot, repoId);
    const legacy = join(runnerRoot, 'jobs', 'old-unpinned-diagnostics');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'stderr.log'), 'old worker diagnostic, no live spec');
    try {
      git(cache, ['update-ref', '--stdin'], commits.map(head => `update refs/pullboard/candidates/${head} ${head}`).join('\n') + '\n');
      assert.equal(git(cache, ['for-each-ref', '--format=%(refname)', 'refs/pullboard/candidates']).split('\n').length, commits.length);
    } finally { lease.release(); }
    git(repo, ['checkout', '-q', '--detach', commits.at(-1)]);
    await execute(showHead, commits.at(-1));
    const retained = git(cache, ['for-each-ref', '--format=%(objectname)', 'refs/pullboard/candidates']).split('\n');
    assert.ok(retained.length <= 300);
    assert.ok(retained.includes(commits[0]), 'the distinct old running job source ref survives');
    assert.ok(retained.includes(commits.at(-1)), 'the second worker retains its requested exact source');
    assert.match(readFileSync(stderr, 'utf8'), /PULLBOARD_RUNNER_CACHE_PRUNE/u);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), commits.at(-1), 'caller source stays exact');
    assert.equal(readFileSync(join(legacy, 'stderr.log'), 'utf8'), 'old worker diagnostic, no live spec');
    assert.ok(!retained.includes(commits[1]), 'an unprotected old candidate ref was actually pruned');
    git(repo, ['checkout', '-q', '--detach', commits[1]]);
    await execute(showHead, commits[1]);
    assert.equal(git(cache, ['rev-parse', `refs/pullboard/candidates/${commits[1]}`]), commits[1],
      'normal source delivery refetches an exact candidate after its cache ref was pruned');
    for (const head of [commits[0], commits.at(-1)]) assert.equal(git(cache, ['cat-file', '-t', head]), 'commit');
  } finally {
    writeFileSync(release, 'done');
    await held;
  }
});
