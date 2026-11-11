/** `pullboard test --census`: every tracked test file in a few shards per runner, one JSONL row per file, one process [C7]. */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Refused } from '../../../../../packages/kernel/light.js';
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import { COLLECTION_ID_ENV } from '../../../../../packages/gate/index.js';
import { allTestOutcomes } from '../../../../../packages/gate/index.js';
import { browserBoundFiles } from '../../../../../packages/gate/index.js';
import { testsNeedGui } from '../../../../../packages/gate/index.js';
import { LANDING_COLLECT_ALL_ENV } from '../../../../../packages/landing/index.js';
import { fileKey } from '../../../../../packages/landing/index.js';
import { planLandingShards } from '../../../../../packages/landing/index.js';
import { runLandingShards } from '../../../../../packages/landing/index.js';
import { shardFileTimes } from '../../../../../packages/landing/index.js';
import { readFileTimes } from '../../../../../packages/gate/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { censusShardCount } from '../../logic/census.js';
import { finalStatus } from '../../logic/census.js';
import { parseShardHeader } from '../../logic/census.js';
import { shardRows } from '../../logic/census.js';

/** Tracked test entry files at HEAD, the way the gate lists them for a full suite. */
async function trackedTests(root) {
  const { trackedDefaultTestFiles } = await import('../../../../../packages/gate/src/io/test/selection.js');
  return trackedDefaultTestFiles(root, process.env).map(file => file.replace(/^\.\//u, ''));
}

/** The HEAD sha, refusing a checkout whose uncommitted changes would make the rows not about that sha. */
function cleanHead(root) {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git(['status', '--porcelain']).stdout.trim()) throw new Refused('CENSUS_DIRTY', 'a census reports on a commit, and this checkout has uncommitted changes', 'commit or discard them, or run the census from a clean checkout of main');
  return git(['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * Run the census here, the one coordinator process for the whole run, and append a row per file to the JSONL as each
 * shard settles. Returns 0 when every file is green.
 *
 * @param {object} io
 * @param {{ info: { root: string } }} ctx
 * @param {{ out?: string, json?: boolean }} values
 * @param {{ shards?: number, prefixes?: string[], run?: typeof runLandingShards }} [options] - `shards` overrides the count the registered runners give; `prefixes` limits the census to files under them (a sample for timing); `run` replaces the shard dispatcher.
 * @returns {Promise<number>}
 */
export async function runCensus(io, ctx, values, { shards, prefixes = [], run = runLandingShards } = {}) {
  const root = ctx.info.root;
  const sha = cleanHead(root);
  const files = (await trackedTests(root)).filter(file => !prefixes.length || prefixes.some(prefix => file.startsWith(prefix.replace(/^\.\//u, ''))));
  if (!files.length) throw new Refused('NO_TEST_FILE', 'no tracked test files match this census', 'run the census from a repository checkout, with path prefixes that name tracked test files');
  const out = resolve(root, values.out ?? join('.git', 'pullboard', 'census', `${sha.slice(0, 10)}.jsonl`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, '');
  const count = Math.min(shards ?? censusShardCount(loadMachineSettings().runners), files.length);
  // The same plan runLandingShards cuts, so a shard's label names the files it held.
  const plan = planLandingShards(files, count, readFileTimes(root), root);
  const rows = new Map();
  const last = new Map();
  const emit = (shard, record) => {
    const text = shardRows({ ...record, files: shard.files.map(file => fileKey(file)), outcomes: allTestOutcomes(record.output), times: shardFileTimes(record.output) }, sha);
    for (const row of text) { rows.set(row.file, row); appendFileSync(out, `${JSON.stringify(row)}\n`); }
  };
  let pending = null;
  const write = (text) => {
    const header = parseShardHeader(text);
    if (header) { pending = header; return; }
    if (!pending || text.startsWith('# landing')) return;
    const shard = plan[Number(pending.label.split('/')[0]) - 1];
    last.set(pending.label, { ...pending, output: text });
    if (shard && finalStatus(pending.status)) emit(shard, { ...pending, output: text });
    pending = null;
  };
  const env = { id: randomUUID(), collect: process.env[LANDING_COLLECT_ALL_ENV], collection: process.env[COLLECTION_ID_ENV] };
  process.env[LANDING_COLLECT_ALL_ENV] = '1';
  process.env[COLLECTION_ID_ENV] = env.id;
  io.err(`pullboard test --census: ${files.length} files at ${sha.slice(0, 10)} in ${plan.length} shards; rows go to ${out}`);
  const started = Date.now();
  try {
    const bound = browserBoundFiles(root, files).then(list => new Set(list));
    await run({ root, runner: resolve(root, 'apps/cli/src/io/run/tests.js'), files, count: plan.length, fullScope: true, parseProcessCensus, write,
      runnerAdmission: gateRunnerAdmission(), needsGui: shardFiles => testsNeedGui(root, shardFiles),
      needsBrowser: async shardFiles => { const set = await bound; return shardFiles.some(file => set.has(file)); } });
  } finally {
    if (env.collect === undefined) delete process.env[LANDING_COLLECT_ALL_ENV]; else process.env[LANDING_COLLECT_ALL_ENV] = env.collect;
    if (env.collection === undefined) delete process.env[COLLECTION_ID_ENV]; else process.env[COLLECTION_ID_ENV] = env.collection;
    // A shard that never reached a last word still owes its files a row.
    for (const shard of plan.entries()) {
      const [index, entry] = shard;
      const label = `${index + 1}/${plan.length}`;
      if (entry.files.every(file => rows.has(fileKey(file)))) continue;
      emit(entry, { label, host: last.get(label)?.host ?? 'none', status: 'unrun', output: '' });
    }
  }
  const counts = {};
  for (const row of rows.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const seconds = Math.round((Date.now() - started) / 1000);
  io.result?.({ out, sha, files: files.length, shards: plan.length, seconds, counts });
  io.say(`census of ${files.length} files at ${sha.slice(0, 10)} in ${seconds}s over ${plan.length} shards: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}; rows in ${out}`);
  return (counts.green ?? 0) === files.length ? 0 : 1;
}
