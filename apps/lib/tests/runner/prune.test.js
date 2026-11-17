/** Real private Git caches preserve job roots while bounded candidate references fall [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { pinSourceCacheJob } from '../../../../packages/runners/index.js';
import { pruneSourceCache } from '../../../../packages/runners/index.js';
import { SOURCE_CACHE_CANDIDATES } from '../../../../packages/runners/index.js';

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
