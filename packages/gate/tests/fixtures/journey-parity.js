/**
 * Shared by the journey parity tests (#8257, #8267): run a sample of converted journey cases twice, once with every CLI call
 * a real process and once in-process, and compare each call's exit code, JSON result, printed text and board state [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { runChildTests } from './child-tests.js';
import { privateFixtureFiles } from './child.js';

const REPOSITORY = resolve(import.meta.dirname, '../../../..');

/**
 * Run a sample in a child node --test in one mode and return each CLI call's record, in call order.
 * @param {string} mode 'process' or 'inprocess'.
 * @param {{ journey: string, cases: string[] }[]} samples Each journey file and the case names (prefixes) to run.
 */
export function runSample(mode, samples) {
  const dir = privateFixtureFiles('pullboard-journey-parity-').root;
  const record = join(dir, `${mode}.jsonl`);
  try {
    for (const { journey, cases } of samples) {
      const pattern = cases.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
      const run = runChildTests([journey], { cwd: REPOSITORY, args: [`--test-name-pattern=^(?:${pattern})`],
        env: { ...process.env, PULLBOARD_JOURNEY_MODE: mode, PULLBOARD_PARITY_RECORD: record } });
      assert.equal(run.status, 0, `the ${mode} run of ${journey} passes:\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`);
      assert.equal(run.pass, cases.length, `every sampled case of ${journey} ran in the ${mode} run`);
    }
    return readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Every difference between two runs' records, named by call: exit code, JSON result, printed text and board state. */
export function parityDifferences(real, inprocess) {
  const differences = [];
  if (real.length !== inprocess.length) differences.push(`call count: process ${real.length}, in-process ${inprocess.length}`);
  for (let at = 0; at < Math.min(real.length, inprocess.length); at++) {
    const call = real[at].args.join(' ');
    for (const field of ['args', 'code', 'json', 'out', 'err', 'board']) {
      const [a, b] = [JSON.stringify(real[at][field]), JSON.stringify(inprocess[at][field])];
      if (a !== b) differences.push(`call ${at + 1} (${call}): ${field} differs\n  process:    ${String(a).slice(0, 400)}\n  in-process: ${String(b).slice(0, 400)}`);
    }
  }
  return differences;
}

