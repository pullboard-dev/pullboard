/** Receive missing history, validate it against the source cache and prepare the isolated checkout and dependencies [C7]. */
import { acquireResourceApi } from './runner-worker-environment.js';
import { git } from './runner-worker-git.js';
import { gitBytes } from './runner-worker-git.js';
import { assertTransportLive } from './runner-worker-process.js';
import { drainOwned } from './runner-worker-process.js';
import { spawnOwned } from './runner-worker-process.js';
import { validateCacheTips } from './runner-overhead.js';
import { tagObjectBodies } from './runner-overhead.js';
import { RUNNER_POLICY_FILE } from './runner-policy.js';
import { runnerPolicyRecord } from './runner-policy.js';
import { pruneSourceCache } from './runner-source-cache.js';
import { restoreSourceTree } from './runner-source-cache.js';
import { rememberSourceTree } from './runner-source-cache.js';
import { checkSourceTagNames } from './runner-source-cache.js';
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

/** Receive the negotiated history pack after the worker announces the cache's candidate tips. */
async function receivePack(packFile) {
  await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
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
    await pruneSourceCache({ cache, runnerRoot, repoId: spec.repoId, roots, lease: cacheLease, git: (...args) => git(S, ...args), env, log: logPrune, proven, inventory });
    const uniqueTips = [...new Set(inventory.values())];
    if (uniqueTips.some(tip => tip.length !== spec.commit.length)) throw new Error('source history cache contains an invalid candidate ref');
    if (uniqueTips.length > 1_024) throw new Error('source history cache needs maintenance');
    if (uniqueTips.some(tip => !proven.has(tip))) throw new Error('source history cache contains a missing or non-commit tip');
    const requestedTagObjects = [...new Set(spec.tags.flatMap(tag => tag.chain))];
    const knownTagObjects = [];
    if (requestedTagObjects.length) {
      const checks = await git(S, cache, ['cat-file', '--batch-check'], env, `${requestedTagObjects.join('\n')}\n`);
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
    await receivePack(packFile);
    measured.packBytes = statSync(packFile).size;
    mark('transferMs');

    const priorIndexes = new Set(readdirSync(join(cache, 'objects', 'pack')).filter(name => name.endsWith('.idx')));
    if (statSync(packFile).size < 12 + spec.commit.length / 2) throw new Error('source history pack is incomplete');
    await git(S, cache, ['index-pack', '--stdin'], env, createReadStream(packFile));
    const checks = (await git(S, cache, ['cat-file', '--batch-check'], env,
      `${roots.join('\n')}\n${spec.commit}^{tree}\n`)).split(/\r?\n/u);
    if (checks.length !== roots.length + 1 || !new RegExp(`^${spec.tree} tree (0|[1-9][0-9]*)$`, 'u').test(checks.at(-1))) {
      throw new Error('source history does not match the requested commit and tree');
    }
    validateCacheTips(roots, checks.slice(0, roots.length).join('\n') + '\n');
    for (const commit of roots) proven.add(commit);
    const candidateHistory = new Set((await git(S, cache, ['rev-list', spec.commit], env)).split(/\r?\n/u).filter(Boolean));
    if (!candidateHistory.size) throw new Error('source history is incomplete');
    if (spec.originBase && !candidateHistory.has(spec.originBase)) throw new Error('source history does not contain its origin base');
    const closure = new Set((await git(S, cache, ['rev-list', '--objects', ...roots], env)).split(/\r?\n/u)
      .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
    closure.add(spec.commit);
    const tagObjects = new Set(spec.tags.flatMap(tag => tag.chain));
    const packDirectory = join(cache, 'objects', 'pack');
    const newIndexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx') && !priorIndexes.has(name));
    const received = new Set();
    for (const indexName of newIndexes) {
      for (const line of (await git(S, cache, ['verify-pack', '-v', join(packDirectory, indexName)], env)).split(/\r?\n/u)) {
        const object = line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1];
        if (object) received.add(object);
      }
    }
    if ([...received].some(object => !closure.has(object) && !tagObjects.has(object))) {
      throw new Error('source history pack contains missing or unrelated objects');
    }
    const tagBodies = requestedTagObjects.length
      ? tagObjectBodies(requestedTagObjects, await gitBytes(S, cache, ['cat-file', '--batch'], env, `${requestedTagObjects.join('\n')}\n`))
      : new Map();
    const lightweight = [...new Set(spec.tags.filter(tag => !tag.chain.length).map(tag => tag.object))];
    if (lightweight.length) validateCacheTips(lightweight,
      await git(S, cache, ['cat-file', '--batch-check'], env, `${lightweight.join('\n')}\n`));
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
      } else if (tag.object !== tag.peeledCommit || !closure.has(tag.object)) {
        throw new Error('lightweight source tag does not point into candidate history');
      }
      if (!candidateHistory.has(tag.peeledCommit)) throw new Error('source tag is not an ancestor of the candidate');
    }
    await git(S, cache, ['update-ref', '--stdin'], env, roots.map(commit => `update refs/pullboard/candidates/${commit} ${commit}\n`).join(''));
    await pruneSourceCache({ cache, runnerRoot, repoId: spec.repoId, roots, lease: cacheLease, git: (...args) => git(S, ...args), env, log: logPrune, proven });
    mark('validateMs');
    const sourceTree = join(repositories, `${spec.repoId}.checkout`);
    measured.reusedCommit = await restoreSourceTree({ directory: sourceTree, root, commit: spec.commit,
      history: candidateHistory, lease: cacheLease, git: (...args) => git(S, ...args), env });
    if (!measured.reusedCommit) await git(S, root, ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`], env);
    if (measured.reusedCommit !== spec.commit) {
      await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache, `refs/pullboard/candidates/${spec.commit}`], env);
      await git(S, root, ['checkout', '--detach', 'FETCH_HEAD'], env);
      rememberSourceTree({ directory: sourceTree, root, commit: spec.commit, tree: spec.tree, lease: cacheLease });
    }
    if (spec.trunk) {
      await git(S, root, ['check-ref-format', spec.trunk.ref], env);
      if (candidateHistory.has(spec.trunk.commit)) await git(S, root, ['update-ref', spec.trunk.ref, spec.trunk.commit], env);
      else await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache,
        `refs/pullboard/candidates/${spec.trunk.commit}:${spec.trunk.ref}`], env);
      await git(S, root, ['config', '--local', '--replace-all', 'pullboard.trunk', spec.trunk.ref], env);
      writeFileSync(join(root, '.git', RUNNER_POLICY_FILE), JSON.stringify(runnerPolicyRecord(spec)), { mode: 0o600 });
    }
    if (spec.trustedMode) {
      const mode = spec.trustedMode;
      await git(S, root, ['check-ref-format', mode.trunk.ref], env);
      if (candidateHistory.has(mode.policyCommit) && candidateHistory.has(mode.trunk.commit)) {
        await git(S, root, ['update-ref', '--stdin'], env, `update refs/pullboard/trusted-policy ${mode.policyCommit}\nupdate ${mode.trunk.ref} ${mode.trunk.commit}\n`);
      } else await git(S, root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache,
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
export async function installDependencies(S, root, runnerRoot, env, tracker) {
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
}
