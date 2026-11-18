/** Shared parts of the in-process parity checks (#8257, #8265): run a journey sample in each mode and diff the call records [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runChildTestsAsync } from './child-tests.js';
import { privateFixtureFiles } from './child.js';

const REPOSITORY = resolve(import.meta.dirname, '../../../..');

/**
 * Run one journey's sample in a child node --test in one mode and return each CLI call's record, in call order.
 * PULLBOARD_SUBMIT_MARKS is blanked in both runs: it is a timing diagnostic a runner's environment may set, written straight to the real process's
 * stderr where an in-process call never sees it, so it would differ in every run for a reason that is not a behaviour difference.
 */
export async function runSample(mode, { journey, cases }) {
  const dir = privateFixtureFiles('pullboard-journey-parity-').root;
  const record = join(dir, `${mode}.jsonl`);
  try {
    // A case may carry a stable-ID prefix (`area.file.slug: `) before its sampled name, so the name match allows one.
    const pattern = cases.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    const run = await runChildTestsAsync([journey], { cwd: REPOSITORY, args: [`--test-name-pattern=^(?:[\\w.-]+: )?(?:${pattern})`],
      env: { ...process.env, PULLBOARD_JOURNEY_MODE: mode, PULLBOARD_PARITY_RECORD: record, PULLBOARD_SUBMIT_MARKS: '' } });
    assert.equal(run.status, 0, `the ${mode} run of the ${journey} sample passes:\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`);
    assert.equal(run.pass, cases.length, `every sampled case of ${journey} ran in the ${mode} run`);
    return readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * A timing field (how long a call waited in a queue) differs between any two runs for a reason that is not a behaviour difference, so it is
 * blanked before the compare: as a JSON key, and as the `queueWaitSeconds: <n>` line show prints [C7].
 */
const TIMING_FIELDS = new Set(['queueWaitSeconds']);
const TIMING_LINES = /\b(queueWaitSeconds): [\d.]+/gu;
function withoutTiming(value) {
  return JSON.stringify(value, (key, inner) => (TIMING_FIELDS.has(key) ? undefined : typeof inner === 'string' ? inner.replace(TIMING_LINES, '$1: <seconds>') : inner));
}

/** Every difference between two runs' records, named by call: exit code, JSON result, printed text and board state. */
export function parityDifferences(real, inprocess) {
  const differences = [];
  if (real.length !== inprocess.length) differences.push(`call count: process ${real.length}, in-process ${inprocess.length}`);
  for (let at = 0; at < Math.min(real.length, inprocess.length); at++) {
    const call = real[at].args.join(' ');
    for (const field of ['args', 'code', 'json', 'out', 'err', 'board']) {
      const [a, b] = [withoutTiming(real[at][field]), withoutTiming(inprocess[at][field])];
      if (a !== b) {
        // Show the text around the first difference, not the start, so a long record names what differs.
        const first = [...a].findIndex((char, index) => char !== b[index]);
        const from = Math.max(0, (first < 0 ? 0 : first) - 150);
        differences.push(`call ${at + 1} (${call}): ${field} differs near character ${first}\n  process:    ${a.slice(from, from + 400)}\n  in-process: ${b.slice(from, from + 400)}`);
      }
    }
  }
  return differences;
}


/** Run every sample in both modes at once and return the differences per journey (they are separate child processes with private sandboxes). */
export async function sampleDifferences(samples) {
  const runs = await Promise.all(samples.map(async sample => ({ sample, real: runSample('process', sample), inprocess: runSample('inprocess', sample) })));
  const found = [];
  for (const { sample, real: realRun, inprocess: inprocessRun } of runs) {
    const real = await realRun;
    const inprocess = await inprocessRun;
    assert.ok(real.length >= 1, `${sample.journey} made its CLI calls (${real.length})`);
    // A journey over a tool that keeps no board (the cell-lints script) says so with boardless: true; its records still compare code, output and error text.
    if (!sample.boardless) assert.ok(real.some(row => row.board?.items.length || row.board?.events.length), `${sample.journey} records carry board state`);
    found.push(...parityDifferences(real, inprocess).map(text => `${sample.journey}: ${text}`));
  }
  return found;
}
