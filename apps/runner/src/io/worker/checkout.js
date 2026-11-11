/** Receive missing history, validate it against the source cache and prepare the isolated checkout and dependencies [C7]. */
import { acquireResourceApi } from './environment.js';
import { git } from './git.js';
import { receiveQueuedPack } from './queue.js';
import { gitBytes } from './git.js';
import { assertTransportLive } from './process.js';
import { drainOwned } from './process.js';
import { spawnOwned } from './process.js';
import { validateCacheTips } from '../../../../../packages/runners/light.js';
import { tagObjectBodies } from '../../../../../packages/runners/light.js';
import { RUNNER_POLICY_FILE } from '../../../../../packages/runners/light.js';
import { runnerPolicyRecord } from '../../../../../packages/runners/light.js';
import { pruneSourceCache } from '../../../../../packages/runners/light.js';
import { borrowWarmCheckout } from '../../../../../packages/runners/light.js';
import { snapshotWarmCheckout } from '../../../../../packages/runners/light.js';
import { recycleWarmCheckout } from '../../../../../packages/runners/light.js';
import { discardWarmCheckout } from '../../../../../packages/runners/light.js';
import { checkSourceTagNames } from '../../../../../packages/runners/light.js';
import { chmodSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Start independent Git reads together and hand back their results to be taken in the original order,
 * so a job pays one process start for the group while the first failing step still names the failure.
 */
async function concurrently(reads) {
  const settled = await Promise.allSettled(reads.map(read => read()));
  return settled.map(result => () => { if (result.status === 'rejected') throw result.reason; return result.value; });
}

/**
 * A fetch names the job's own base commit as its negotiation tip: a checkout's only have is a detached
 * HEAD, which Git never advertises, so without it the cache resends the whole history on every job.
 */
function negotiationTip(commit) { return commit ? [`--negotiation-tip=${commit}`] : []; }

/** Receive the negotiated history pack after the worker announces the cache's candidate tips. */
async function receivePack(S, packFile) {
  if (!await receiveQueuedPack(S, packFile)) await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
}

/** Receive only missing ancestry, validate the full graph, then copy the exact commit into a clean job repository. */
export async function checkoutHistory(S, api, runnerRoot, root, packFile, spec, env) {
  const started = performance.now();
  const measured = { version: 1, git: {}, stages: {} };
  S.sourcePreparation = measured;
  let boundary = started;
  /** Record disjoint source phases from the worker's monotonic clock. */
  const mark = name => {
    const now = performance.now();
    measured.stages[name] = Math.round(now - boundary);
    boundary = now;
  };
  const repositories = join(runnerRoot, 'repos');
  mkdirSync(repositories, { recursive: true, mode: 0o700 });
  chmodSync(repositories, 0o700);
  const cache = join(repositories, `${spec.repoId}.git`);
  const cacheLease = await acquireResourceApi(api, {
    name: `repo-${spec.repoId}`, capacity: 1, scope: 'machine', root: runnerRoot,
    repo: runnerRoot, agent: `pullboard-ssh-cache-${spec.id}`, kind: 'source-cache',
    onWait: () => assertTransportLive(S),
  }, join(runnerRoot, 'cache', 'resource-pool')).catch(error => {
    if (error && typeof error === 'object') error.runnerSetupStep = 'source cache admission';
    throw error;
  });
  mark('cacheWaitMs');
  const deliveryRefs = [];
  const warmPool = join(repositories, `${spec.repoId}.checkouts`);
  let warm = null;
  /** Recycle under the same cache admission only after the command's descendants have drained. */
  S.recycleSource = async () => {
    S.recycleSource = null;
    if (!warm) return;
    let admission;
    try {
      if (S.transportLost || S.cleanupTimedOut) throw new Error('source cache return cancelled');
      admission = await acquireResourceApi(api, {
        name: `repo-${spec.repoId}`, capacity: 1, scope: 'machine', root: runnerRoot,
        repo: runnerRoot, agent: `pullboard-ssh-return-${spec.id}`, kind: 'source-cache',
        onWait: () => { assertTransportLive(S); if (Date.now() >= S.cleanupDeadline) throw new Error('source cache return deadline'); },
      }, join(runnerRoot, 'cache', 'resource-pool'));
      await recycleWarmCheckout(warm, { lease: admission, git: (...args) => git(S, ...args), env });
    } catch (error) {
      const code = /^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'unavailable';
      process.stderr.write(`PULLBOARD_RUNNER_WARM_CACHE_DROP ${spec.id} ${JSON.stringify({ step: error?.runnerSetup?.step ?? 'pool return', code })}\n`);
      discardWarmCheckout(warm);
    }
    finally { admission?.release(); }
  };
  try {
    if (!existsSync(cache)) {
      const build = mkdtempSync(join(repositories, `.repo-${spec.repoId}-`));
      const staged = join(build, 'cache.git');
      try {
        const initialize = async () => {
          await git(S, build, ['init', '--bare', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`, staged], env);
        };
        await initialize();
        if (spec.origin && spec.originBase) {
          let seeded = false;
          try {
            await git(S, staged, ['-c', 'protocol.version=2', 'fetch', '--no-tags', '--no-recurse-submodules', spec.origin, spec.originBase], env);
            seeded = await git(S, staged, ['cat-file', '-t', spec.originBase], env) === 'commit'
              && Number(await git(S, staged, ['rev-list', '--count', spec.originBase], env)) > 0
              && !existsSync(join(staged, 'shallow'));
            if (seeded) await git(S, staged, ['update-ref', `refs/pullboard/published/${spec.originBase}`, spec.originBase], env);
          } catch { seeded = false; }
          if (!seeded) {
            rmSync(staged, { recursive: true, force: true });
            await initialize();
          }
        }
        renameSync(staged, cache);
      } finally { rmSync(build, { recursive: true, force: true }); }
    }
    const cacheShape = await git(S, cache, ['rev-parse', '--is-bare-repository', '--show-object-format'], env);
    if (cacheShape !== `true\n${spec.commit.length === 64 ? 'sha256' : 'sha1'}`
      || existsSync(join(cache, 'shallow')) || existsSync(join(cache, 'objects', 'info', 'alternates'))) {
      throw new Error('source history cache has an incompatible format');
    }
    const roots = [...new Set([spec.commit, ...(spec.trunk ? [spec.trunk.commit] : []), ...(spec.trustedMode ? [spec.trustedMode.policyCommit, spec.trustedMode.trunk.commit] : [])])];
    /** Log exact ref deletions without reporting candidate source or credentials. */
    const logPrune = result => process.stderr.write(`PULLBOARD_RUNNER_CACHE_PRUNE ${spec.id} ${JSON.stringify(result)}\n`);
    const proven = new Set(), inventory = new Map();
    const requestedTagObjects = [...new Set(spec.tags.flatMap(tag => tag.chain))];
    // Tag objects are read-only lookups, so they run beside the ref pruning rather than after it.
    const [pruneRead, tagInventoryRead] = await concurrently([
      () => pruneSourceCache({ cache, runnerRoot, repoId: spec.repoId, roots, lease: cacheLease, git: (...args) => git(S, ...args), env, log: logPrune, proven, inventory }),
      () => requestedTagObjects.length ? git(S, cache, ['cat-file', '--batch-check'], env, `${requestedTagObjects.join('\n')}\n`) : null,
    ]);
    pruneRead();
    const uniqueTips = [...new Set(inventory.values())];
    if (uniqueTips.some(tip => tip.length !== spec.commit.length)) throw new Error('source history cache contains an invalid candidate ref');
    if (uniqueTips.length > 1_024) throw new Error('source history cache needs maintenance');
    if (uniqueTips.some(tip => !proven.has(tip))) throw new Error('source history cache contains a missing or non-commit tip');
    const knownTagObjects = [];
    if (requestedTagObjects.length) {
      const checks = tagInventoryRead();
      const lines = checks.split(/\r?\n/u).filter(Boolean);
      if (lines.length !== requestedTagObjects.length) throw new Error('source tag inventory is incomplete');
      for (let index = 0; index < lines.length; index++) {
        const match = /^([a-f0-9]{40,64}) tag \d+$/u.exec(lines[index]);
        if (match && match[1] === requestedTagObjects[index]) knownTagObjects.push(match[1]);
        else if (!new RegExp(`^${requestedTagObjects[index]} missing$`, 'u').test(lines[index])) {
          throw new Error('source tag inventory contains an invalid object');
        }
      }
    }
    mark('inventoryMs');
    await new Promise((resolveWrite, rejectWrite) => process.stderr.write(
      `PULLBOARD_RUNNER_NEED ${spec.id} ${Buffer.from(JSON.stringify({ tips: uniqueTips, tagObjects: knownTagObjects })).toString('base64')}\n`,
      error => error ? rejectWrite(error) : resolveWrite()));
    await receivePack(S, packFile);
    measured.packBytes = statSync(packFile).size;
    mark('transferMs');

    const priorIndexes = new Set(readdirSync(join(cache, 'objects', 'pack')).filter(name => name.endsWith('.idx')));
    if (statSync(packFile).size < 12 + spec.commit.length / 2) throw new Error('source history pack is incomplete');
    await git(S, cache, ['index-pack', '--stdin'], env, createReadStream(packFile));
    /** Objects reachable from the roots, optionally excluding what the cache's earlier tips already reach. */
    const reachable = async (exclude = []) => {
      const objects = new Set((await git(S, cache, ['rev-list', '--objects', '--stdin'], env,
        `${[...roots, ...exclude.map(tip => `^${tip}`)].join('\n')}\n`)).split(/\r?\n/u)
        .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
      objects.add(spec.commit);
      return objects;
    };
    const packDirectory = join(cache, 'objects', 'pack');
    const newIndexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx') && !priorIndexes.has(name));
    const lightweight = [...new Set(spec.tags.filter(tag => !tag.chain.length).map(tag => tag.object))];
    // Every read below only inspects the cache, so all start at once; each result is still checked in order.
    const [rootsRead, historyRead, recentRead, packsRead, bodiesRead, lightweightRead] = await concurrently([
      () => git(S, cache, ['cat-file', '--batch-check'], env, `${roots.join('\n')}\n${spec.commit}^{tree}\n`),
      () => git(S, cache, ['rev-list', spec.commit], env),
      // The pack was cut against the announced tips, so only new objects need walking; the full closure is the fallback.
      () => reachable(uniqueTips),
      () => Promise.all(newIndexes.map(indexName => git(S, cache, ['verify-pack', '-v', join(packDirectory, indexName)], env))),
      () => requestedTagObjects.length ? gitBytes(S, cache, ['cat-file', '--batch'], env, `${requestedTagObjects.join('\n')}\n`) : null,
      () => lightweight.length ? git(S, cache, ['cat-file', '--batch-check'], env, `${lightweight.join('\n')}\n`) : null,
    ]);
    const checks = rootsRead().split(/\r?\n/u);
    if (checks.length !== roots.length + 1 || !new RegExp(`^${spec.tree} tree (0|[1-9][0-9]*)$`, 'u').test(checks.at(-1))) {
      throw new Error('source history does not match the requested commit and tree');
    }
    validateCacheTips(roots, checks.slice(0, roots.length).join('\n') + '\n');
    for (const commit of roots) proven.add(commit);
    const candidateHistory = new Set(historyRead().split(/\r?\n/u).filter(Boolean));
    if (!candidateHistory.size) throw new Error('source history is incomplete');
    if (spec.originBase && !candidateHistory.has(spec.originBase)) throw new Error('source history does not contain its origin base');
    let closure = recentRead();
    const tagObjects = new Set(spec.tags.flatMap(tag => tag.chain));
    const received = new Set();
    for (const listing of packsRead()) {
      for (const line of listing.split(/\r?\n/u)) {
        const object = line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1];
        if (object) received.add(object);
      }
    }
    const unrelated = () => [...received].some(object => !closure.has(object) && !tagObjects.has(object));
    if (uniqueTips.length && unrelated()) closure = await reachable();
    if (unrelated()) throw new Error('source history pack contains missing or unrelated objects');
    const tagBodies = requestedTagObjects.length ? tagObjectBodies(requestedTagObjects, bodiesRead()) : new Map();
    if (lightweight.length) validateCacheTips(lightweight, lightweightRead());
    await checkSourceTagNames({ cache, tags: spec.tags, id: spec.id, lease: cacheLease, git: (...args) => git(S, ...args), env, objectLength: spec.commit.length });
    for (const tag of spec.tags) {
      if (tag.chain.length) {
        let target = tag.object;
        for (let index = 0; index < tag.chain.length; index++) {
          const object = tag.chain[index];
          if (target !== object || (!received.has(object) && !knownTagObjects.includes(object)) || !tagBodies.has(object)) {
            throw new Error('source tag chain is incomplete or unrelated');
          }
          const body = tagBodies.get(object).trim();
          const header = body.split(/\r?\n\r?\n/u, 1)[0];
          const next = /^object ([a-f0-9]{40,64})$/mu.exec(header)?.[1];
          const type = /^type (commit|tag|tree|blob)$/mu.exec(header)?.[1];
          const expectedNext = tag.chain[index + 1] ?? tag.peeledCommit;
          const expectedType = index + 1 < tag.chain.length ? 'tag' : 'commit';
          if (!next || next !== expectedNext || type !== expectedType || next.length !== spec.commit.length) {
            throw new Error('source tag chain failed validation');
          }
          target = next;
        }
      } else if (tag.object !== tag.peeledCommit || !candidateHistory.has(tag.object)) {
        throw new Error('lightweight source tag does not point into candidate history');
      }
      if (!candidateHistory.has(tag.peeledCommit)) throw new Error('source tag is not an ancestor of the candidate');
    }
    await git(S, cache, ['update-ref', '--stdin'], env, roots.map(commit => `update refs/pullboard/candidates/${commit} ${commit}\n`).join(''));
    mark('validateMs');
    // Pruning touches only cache refs and borrowing only the warm pool and job root, so both run under the one lease together.
    const [borrowRead, prunedRead] = await concurrently([
      () => borrowWarmCheckout({ directory: warmPool, legacy: join(repositories, `${spec.repoId}.checkout`), root, commit: spec.commit,
        history: candidateHistory, lease: cacheLease, git: (...args) => git(S, ...args), env }),
      () => pruneSourceCache({ cache, runnerRoot, repoId: spec.repoId, roots, lease: cacheLease, git: (...args) => git(S, ...args), env, log: logPrune, proven }),
    ]);
    warm = borrowRead();
    prunedRead();
    measured.reusedCommit = warm?.reusedCommit ?? null;
    if (!measured.reusedCommit) await git(S, root, ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`], env);
    if (measured.reusedCommit !== spec.commit) {
      await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', ...negotiationTip(measured.reusedCommit), cache, `refs/pullboard/candidates/${spec.commit}`], env);
      await git(S, root, ['checkout', '--detach', 'FETCH_HEAD'], env);
    }
    // A trunk commit main lands mid-job is fetched from here before a read, never refused as missing (#2534).
    if (spec.origin) await git(S, root, ['config', '--local', '--replace-all', 'pullboard.fetchSource', spec.origin], env);
    warm = snapshotWarmCheckout({ directory: warmPool, root, commit: spec.commit, tree: spec.tree, lease: cacheLease, borrowed: warm });
    if (spec.trunk) {
      if (candidateHistory.has(spec.trunk.commit)) {
        // The job checkout is private and discarded on failure, so the name check runs beside the two writes it guards.
        const [formatRead, ...writes] = await concurrently([
          () => git(S, root, ['check-ref-format', spec.trunk.ref], env),
          () => git(S, root, ['update-ref', spec.trunk.ref, spec.trunk.commit], env),
          () => git(S, root, ['config', '--local', '--replace-all', 'pullboard.trunk', spec.trunk.ref], env),
        ]);
        formatRead();
        for (const write of writes) write();
      } else {
        await git(S, root, ['check-ref-format', spec.trunk.ref], env);
        await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', ...negotiationTip(spec.commit), cache,
          `refs/pullboard/candidates/${spec.trunk.commit}:${spec.trunk.ref}`], env);
        await git(S, root, ['config', '--local', '--replace-all', 'pullboard.trunk', spec.trunk.ref], env);
      }
      writeFileSync(join(root, '.git', RUNNER_POLICY_FILE), JSON.stringify(runnerPolicyRecord(spec)), { mode: 0o600 });
    }
    if (spec.trustedMode) {
      const mode = spec.trustedMode;
      await git(S, root, ['check-ref-format', mode.trunk.ref], env);
      if (candidateHistory.has(mode.policyCommit) && candidateHistory.has(mode.trunk.commit)) {
        await git(S, root, ['update-ref', '--stdin'], env, `update refs/pullboard/trusted-policy ${mode.policyCommit}\nupdate ${mode.trunk.ref} ${mode.trunk.commit}\n`);
      } else await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', ...negotiationTip(spec.commit), cache,
        `refs/pullboard/candidates/${mode.policyCommit}:refs/pullboard/trusted-policy`,
        `refs/pullboard/candidates/${mode.trunk.commit}:${mode.trunk.ref}`], env);
      await git(S, root, ['config', '--local', '--replace-all', 'pullboard.trunk', mode.trunk.ref], env);
      writeFileSync(join(root, '.git', RUNNER_POLICY_FILE), JSON.stringify(runnerPolicyRecord({ ...spec, trunk: mode.trunk })), { mode: 0o600 });
    }
    if (spec.tags.length) {
      const updates = spec.tags.map((tag, index) => {
        const deliveryRef = `refs/pullboard/tag-delivery/${spec.id}/${index}`;
        deliveryRefs.push(deliveryRef);
        return `update ${deliveryRef} ${tag.object}`;
      });
      await git(S, cache, ['update-ref', '--stdin'], env, `${updates.join('\n')}\n`);
      // Bound actual UTF-8 argv bytes, so short tags do not require needless fixed-count batches.
      const fetchArgs = ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache];
      for (let index = 0; index < spec.tags.length;) {
        const tags = [], refspecs = [];
        let bytes = fetchArgs.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 4);
        while (index < spec.tags.length) {
          const tag = spec.tags[index], refspec = `${deliveryRefs[index]}:${tag.name}`;
          const size = Buffer.byteLength(refspec) + 1;
          if (bytes + size > 32_768) {
            if (!tags.length) throw new Error('source tag ref exceeds the safe argument limit');
            break;
          }
          tags.push(tag); refspecs.push(refspec); bytes += size; index++;
        }
        await git(S, root, [...fetchArgs, ...refspecs], env);
        const peeled = (await git(S, root, ['rev-parse', '--revs-only', '--end-of-options', ...tags.map(tag => `${tag.name}^{}`)], env)).split(/\r?\n/u);
        if (peeled.length !== tags.length || tags.some((tag, offset) => peeled[offset] !== tag.peeledCommit)) {
          throw new Error('isolated source checkout has an invalid tag ref');
        }
      }
    }
    if (await git(S, root, ['rev-parse', '--is-shallow-repository', 'HEAD', 'HEAD^{tree}'], env) !== `false\n${spec.commit}\n${spec.tree}`
      || existsSync(join(root, '.git', 'objects', 'info', 'alternates'))) {
      throw new Error('isolated source checkout does not contain the complete requested history');
    }
  } finally {
    if (deliveryRefs.length) {
      try { await git(S, cache, ['update-ref', '--stdin'], env, `${deliveryRefs.map(ref => `delete ${ref}`).join('\n')}\n`); }
      catch { /* Leave cache refs only if Git refuses safe removal. */ }
    }
    mark('materializeMs');
    measured.totalMs = Math.round(performance.now() - started);
    S.sourcePreparation = null;
    try { cacheLease.release(); } catch { /* Retaining the lease on cleanup error is safer than speculative deletion. */ }
  }
  rmSync(packFile, { force: true });
  return measured;
}

/** Install committed npm dependencies through an isolated content-addressed cache, refusing unknown lock managers. */
export async function installDependencies(S, root, runnerRoot, env, tracker, api) {
  const packageFile = join(root, 'package.json');
  if (!existsSync(packageFile)) return;
  const packageText = readFileSync(packageFile, 'utf8');
  const manifest = JSON.parse(packageText);
  const lockFile = join(root, 'package-lock.json');
  if (existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'yarn.lock'))) {
    throw new Error('dependency setup requires a single committed npm lock manager');
  }
  if (!existsSync(lockFile)) {
    if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) {
      throw new Error('dependency setup requires a committed npm package-lock.json');
    }
    return;
  }
  const admission = await acquireResourceApi(api, { name: 'cache-npm', capacity: 1, scope: 'machine', root: runnerRoot,
    repo: runnerRoot, agent: `pullboard-ssh-npm-${S.workerId}`, kind: 'dependency-cache',
    onWait: () => assertTransportLive(S) }, join(runnerRoot, 'cache', 'resource-pool'));
  try {
    const cacheRoot = join(runnerRoot, 'cache', 'npm');
    const contentCache = join(cacheRoot, 'content');
    mkdirSync(contentCache, { recursive: true, mode: 0o700 });
    chmodSync(cacheRoot, 0o700); chmodSync(contentCache, 0o700);
    // node_modules is job-local because package lifecycle scripts may create sibling artifacts.
    // Reuse only npm's content-addressed download cache, never a prior job's installed tree.
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    const npm = spawnOwned(S, 'npm', ['ci', '--cache', contentCache], {
      cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const result = await npm.closed;
    await tracker.stopDescendants();
    await drainOwned(S, npm);
    if (result.error || result.code !== 0 || result.signal) throw new Error('committed npm dependencies could not be installed');
  } finally { admission.release(); }
}
