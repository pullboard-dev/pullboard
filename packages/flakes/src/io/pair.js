/**
 * A red pulled gate's paired rerun: inside the gate job, each failing case runs once more at the candidate and once at
 * pinned main, and the receipt carries both results; the original red stays the verdict [C7,H16].
 * Why in the job: the runner already holds the candidate checkout and main's objects, so no second job or host is needed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { loadavg } from 'node:os';
import { join } from 'node:path';

const fs = fileSystemAdapter();

// Budget: a pair reruns at most 8 files of 20 cases each, so a red with hundreds of cases stays one bounded diagnostic.
const MOST_FILES = 8;
const MOST_NAMES = 20;
// Budget: each probe's receipt keeps the last 1500 characters of its output, so the gate receipt stays under its cap.
const TAIL = 1500;
const TAP_ROW = /^(not )?ok [0-9]+ - (.*)$/u;

/**
 * The failing cases a red gate pairs, one group per file: only phases that named their cases and whose command has a
 * structured Node runner (`prefixes[role]`) are paired, and a case two phases share is paired once.
 *
 * @param {{ role: string, status: number | null, failures?: { file: string, name: string }[] | null }[]} phases
 * @param {Record<string, string | null | undefined>} prefixes - The runner prefix per phase role; absent, that phase is not paired.
 * @returns {{ phase: string, file: string, prefix: string, names: string[] }[]}
 */
export function pairTargets(phases, prefixes) {
  const groups = new Map();
  for (const phase of phases ?? []) {
    const prefix = prefixes?.[phase.role];
    if (phase.status === 0 || !Array.isArray(phase.failures) || typeof prefix !== 'string' || !prefix.trim()) continue;
    for (const row of phase.failures) {
      if (typeof row?.file !== 'string' || !row.file || typeof row.name !== 'string' || !row.name) continue;
      const group = groups.get(row.file) ?? { phase: phase.role, file: row.file, prefix: prefix.trim(), names: [] };
      if (!group.names.includes(row.name) && group.names.length < MOST_NAMES) group.names.push(row.name);
      groups.set(row.file, group);
    }
  }
  return [...groups.values()].slice(0, MOST_FILES);
}

/** An exact-name selector for Node's --test-name-pattern: every name escaped and anchored. */
export function namePattern(names) {
  return '^(?:' + names.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|') + ')$';
}

/**
 * Each named case's result in one probe: true or false only where the run's structured outcomes, or a top-level TAP
 * row, name that case; null otherwise. A pass needs a clean exit too, so a crash after a passing row proves nothing.
 *
 * @param {{ status: number | null, text: string, outcomes: { file: string, name: string, passed: boolean, skipped: boolean }[] | null }} run
 * @param {string} file
 * @param {string[]} names
 * @returns {Record<string, boolean | null>}
 */
export function caseResults({ status, text, outcomes }, file, names) {
  const tap = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const row = TAP_ROW.exec(line);
    if (!row || /# SKIP|# TODO/u.test(row[2])) continue;
    tap.set(row[2].replace(/\\#/gu, '#'), !row[1]);
  }
  return Object.fromEntries(names.map(name => {
    const outcome = Array.isArray(outcomes) ? outcomes.find(row => row.file === file && row.name === name && !row.skipped) : null;
    const passed = outcome ? outcome.passed : tap.has(name) ? tap.get(name) : null;
    return [name, passed === true ? status === 0 : passed === false ? false : null];
  }));
}

/** Run one probe without a shell in `cwd`, reading its whole output; the exit and digest describe that output. */
async function probe(argv, cwd, env, { readOutcomes, timingEnv }, file, names) {
  const id = randomUUID(), started = Date.now();
  const ran = await new Promise(resolve => {
    const child = spawn(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd, env: { ...env, ...(timingEnv ? { [timingEnv]: id } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => out.push(chunk));
    child.on('error', () => resolve({ status: null, signal: null, output: Buffer.concat(out) }));
    child.on('close', (status, signal) => resolve({ status, signal, output: Buffer.concat(out) }));
  });
  const text = ran.output.toString('utf8');
  let outcomes = null;
  try { outcomes = typeof readOutcomes === 'function' ? readOutcomes(text, id) : null; } catch { outcomes = null; }
  const named = Array.isArray(outcomes) ? outcomes.filter(row => row.file === file && names.includes(row.name)) : null;
  return { status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(ran.output).digest('hex'), bytes: ran.output.length,
    tail: text.length > TAIL ? text.slice(-TAIL) : text, ms: Date.now() - started, results: caseResults({ status: ran.status, text, outcomes }, file, names),
    ...(named?.length ? { testOutcomes: named } : {}) };
}

/**
 * Pair a red gate's failing cases: per file, one exact-name rerun at the candidate checkout, then one at pinned main
 * when main has the file. Nothing here changes a phase or the verdict; the board classifies what the receipt carries.
 * mainRoot gives main's extracted tree, asked once and only when a case can be paired; the gate job owns that folder.
 *
 * @param {{ root: string, phases: object[], flakes: { prefixes?: Record<string, string> }, mainRoot: () => string | null, env: Record<string, string>,
 *   readOutcomes?: (text: string, id: string) => object[] | null, timingEnv?: string }} options
 * @returns {Promise<object[] | null>} One row per paired file, or null when no case can be paired.
 */
export async function pairReds({ root, phases, flakes, mainRoot, env, readOutcomes, timingEnv }) {
  const targets = pairTargets(phases, flakes?.prefixes);
  if (!targets.length) return null;
  const load = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
  let trunk = null;
  try { trunk = typeof mainRoot === 'function' ? mainRoot() : null; } catch { trunk = null; }
  const pairs = [];
  for (const target of targets) {
    const argv = [...target.prefix.split(/\s+/u), '--test-name-pattern', namePattern(target.names), target.file];
    const paired = await probe(argv, root, env, { readOutcomes, timingEnv }, target.file, target.names);
    const atMain = trunk && fs.exists(join(trunk, target.file)) ? await probe(argv, trunk, env, { readOutcomes, timingEnv }, target.file, target.names) : null;
    pairs.push({ phase: target.phase, file: target.file, names: target.names, commandSha256: createHash('sha256').update(argv.join(' ')).digest('hex'),
      load, paired, main: atMain });
  }
  return pairs;
}
