/**
 * The in-process journey pilot's measuring tools (#8058): run one journey file as real processes and in-process, time each,
 * seed one fault at a time through module hooks, and count which version fails on which fault [C7].
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../child.js';

export const REPOSITORY = resolve(import.meta.dirname, '../../../../..');
const REGISTER = pathToFileURL(resolve(import.meta.dirname, 'pilot-register.js')).href;
const JOURNEYS = 'apps/cli/journeys/blueprint';

/** The versions compared: the same permutations as real processes, in-process, the real-process contract, and the parity check. */
export const LEGS = Object.freeze({
  real: { file: `${JOURNEYS}/init.test.js`, env: { PULLBOARD_JOURNEY_MODE: 'process' } },
  inprocess: { file: `${JOURNEYS}/init.test.js`, env: {} },
  contract: { file: `${JOURNEYS}/init.contract.test.js`, env: {} },
  parity: { file: `${JOURNEYS}/init.parity.test.js`, env: {} },
});

/**
 * Run one leg of the pilot in a child node --test, with a fault seeded when given.
 *
 * @param {keyof typeof LEGS} leg - Which version to run.
 * @param {{ fault?: { file: string, find: string, replace: string }, timeoutMs?: number }} [options]
 * @returns {{ passed: boolean, timedOut: boolean, ms: number, applied: boolean }} applied: the fault's text was found and changed in a module this leg loaded.
 */
export function runLeg(leg, { fault = null, timeoutMs = 420_000 } = {}) {
  const scratch = privateFixtureFiles('pullboard-pilot-').root;
  const log = join(scratch, 'fault.log');
  const env = { ...process.env, ...LEGS[leg].env, NODE_OPTIONS: `--import=${REGISTER}`, PULLBOARD_PILOT_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  if (fault) env.PULLBOARD_PILOT_FAULT = JSON.stringify(fault); else delete env.PULLBOARD_PILOT_FAULT;
  const started = performance.now();
  const result = spawnSync(process.execPath, ['--test', LEGS[leg].file], { cwd: REPOSITORY, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: 'pipe' });
  const ms = Math.round(performance.now() - started);
  let logged = '';
  try { logged = readFileSync(log, 'utf8'); } catch { /* no module hook ran, or none wrote */ }
  rmSync(scratch, { recursive: true, force: true });
  return { passed: result.status === 0, timedOut: result.error?.code === 'ETIMEDOUT', ms, applied: logged.split('\n').includes('applied') };
}

/**
 * One fault's row: which versions failed on it. The parity check runs only when neither the in-process permutations nor the
 * contract caught the fault, since the kept design is their union with parity.
 *
 * @param {{ id: string, kind: string, file: string, find: string, replace: string }} fault
 * @returns {{ id: string, kind: string, caught: Record<string, boolean | null>, applied: Record<string, boolean | null>, ms: Record<string, number | null> }}
 */
export function studyFault(fault) {
  const row = { id: fault.id, kind: fault.kind, caught: {}, applied: {}, ms: {} };
  const seed = { file: fault.file, find: fault.find, replace: fault.replace };
  for (const leg of ['real', 'inprocess', 'contract', 'parity']) {
    if (leg === 'parity' && (row.caught.inprocess || row.caught.contract)) { row.caught[leg] = null; row.applied[leg] = null; row.ms[leg] = null; continue; }
    const ran = runLeg(leg, { fault: seed });
    row.caught[leg] = !ran.passed; row.applied[leg] = ran.applied; row.ms[leg] = ran.ms;
    if (ran.timedOut) row.caught[leg] = null;
  }
  return row;
}

/** The middle value of a list of numbers. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The share of seeded faults each version catches, from the per-fault rows. A version "catches" a fault when its run
 * fails with the fault seeded; the kept design (in-process permutations, contract and parity) catches the union.
 *
 * @param {{ id: string, kind: string, caught: Record<string, boolean | null> }[]} rows
 * @returns {{ faults: number, real: number, inprocess: number, kept: number, missedByInprocessOnly: string[], missedByKept: string[], byKind: Record<string, { faults: number, real: number, inprocess: number, kept: number }> }}
 */
export function catchRates(rows) {
  const count = (list, test) => list.filter(test).length;
  const real = (row) => row.caught.real === true;
  const inprocess = (row) => row.caught.inprocess === true;
  const kept = (row) => inprocess(row) || row.caught.contract === true || row.caught.parity === true;
  const byKind = {};
  for (const kind of new Set(rows.map((row) => row.kind))) {
    const own = rows.filter((row) => row.kind === kind);
    byKind[kind] = { faults: own.length, real: count(own, real), inprocess: count(own, inprocess), kept: count(own, kept) };
  }
  return { faults: rows.length, real: count(rows, real), inprocess: count(rows, inprocess), kept: count(rows, kept),
    missedByInprocessOnly: rows.filter((row) => real(row) && !inprocess(row)).map((row) => row.id),
    missedByKept: rows.filter((row) => real(row) && !kept(row)).map((row) => row.id), byKind };
}

/** The median runtime of each version over its unmutated runs, in milliseconds. */
export function medianRuntimes(runs) {
  return Object.fromEntries(Object.entries(runs).map(([leg, list]) => [leg, median(list)]));
}
