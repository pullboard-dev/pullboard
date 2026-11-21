/** Carry completed sealed-file runner proof into an opted-in census [C7,#12641]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { environmentProblem } from '../../../../../packages/config/index.js';
import { preQueueReuse } from '../../../../../packages/gate/index.js';
import { testResultDigest } from '../../../../../packages/gate/index.js';
import { testResultStore } from '../../../../../packages/gate/index.js';
import { git } from '../../../../../packages/git/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { verifyRunnerReceipt } from '../../../../../packages/runners/index.js';
import { reviewMainPolicy } from '../../../../../packages/sandbox/light.js';
import { storeName } from '../store-names.js';

/** Only accepted sealed cell tests are supported, excluding named journey exceptions in either snapshot. */
function sealedFiles(root, sha, main, files) {
  const listing = commit => JSON.parse(git(root, ['show', `${commit}:packages/gate/data/tests/test-cells.json`]));
  const accepted = listing(main), candidate = sha === main ? accepted : listing(sha);
  return files.filter(file => {
    const [, scope, name] = /^(packages|apps)\/([^/]+)\/tests\//u.exec(file) ?? [];
    const cell = scope === 'apps' ? `${scope}/${name}` : name;
    return cell && !file.includes('/journeys/') && accepted.sealed.includes(cell) && candidate.sealed.includes(cell)
      && !Object.hasOwn(accepted.journeys ?? {}, file) && !Object.hasOwn(candidate.journeys ?? {}, file);
  });
}

/** Read the bounded original packet only after verifying its retained runner signature and completion. */
function signedRows(store, held, key) {
  try {
    const receipt = JSON.parse(readFileSync(join(store, 'completions', storeName(held.id)), 'utf8'));
    const { testResults, ...completion } = receipt;
    if (typeof testResults !== 'string' || testResults.length > 512 * 1024
      || JSON.stringify(held) !== JSON.stringify(completion) || !verifyRunnerReceipt(receipt, key)) return new Set();
    const rows = JSON.parse(gunzipSync(Buffer.from(testResults, 'base64'), { maxOutputLength: 8 * 1024 * 1024 }));
    return new Set(Array.isArray(rows) ? rows.map(testResultDigest) : []);
  } catch { return new Set(); }
}

/** Match the cached result to a row actually covered by the pinned runner signature. */
function signedCompletion(store, entry, runtime, tooling, keys, verified) {
  const { completion: held, ...origin } = entry.origin;
  if (held.runtimeSha256 !== runtime || held.toolingSha256 !== tooling
    || `v${held.environment?.node}` !== entry.context.node
    || held.environment?.platform !== entry.context.platform || held.environment?.arch !== entry.context.arch) return false;
  const key = keys.get(origin.machine);
  if (!key || !held.signature) return false;
  const cacheKey = testResultDigest([origin.machine, held]);
  if (!verified.has(cacheKey)) verified.set(cacheKey, signedRows(store, held, key));
  return verified.get(cacheKey).has(testResultDigest({ ...entry, origin }));
}

/** Use the controller's authenticated whole-file store. The caller keeps pull census fresh until it has that source. */
export async function censusCarry(root, { files, sha, runners, trustedTooling = runnerExecutionServices().trustedTooling }) {
  const fresh = { run: files, carried: [] };
  if (['0', 'record'].includes(process.env.PULLBOARD_TEST_REUSE)) return fresh;
  try {
    const policy = reviewMainPolicy(root);
    const environment = policy.config.landing?.environment;
    // Use an explicitly pinned runtime, never the coordinator's Node or a runtime guessed from a past green.
    if (environmentProblem(environment)) return fresh;
    const eligible = sealedFiles(root, sha, policy.commit, files);
    if (!eligible.length) return fresh;
    const keys = new Map((runners ?? []).filter(runner => runner.publicKey).map(runner => [runner.host, runner.publicKey]));
    if (!keys.size) return fresh;
    const { tooling, runtime } = trustedTooling();
    const store = testResultStore(root);
    const runtimes = [{ ...environment, node: `v${environment.node}` }];
    const { reused } = await preQueueReuse(root, sha, eligible, tooling.sha256, { runtimes });
    const carried = [], verified = new Map();
    for (const [file, { entry, key }] of reused) {
      const { passed, skipped, todo } = entry.tap.counts;
      if (!passed || skipped || todo || !signedCompletion(store, entry, runtime.sha256, tooling.sha256, keys, verified)) continue;
      carried.push({ file, sha, status: 'green', carried: true, carriedFrom: entry.commit, proof: { key, receipt: entry.origin.completion.id } });
    }
    const held = new Set(carried.map(row => row.file));
    return { run: files.filter(file => !held.has(file)), carried };
  } catch { return fresh; }
}
