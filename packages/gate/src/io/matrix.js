#!/usr/bin/env node
/**
 * The pipeline hop matrix [C7]: every hop from claim to merged, the invariant it must keep, the harness that proves it
 * and the live receipt that shows it in production. `node packages/gate/src/io/matrix.js` runs every harness under
 * packages/gate/tests/fixtures/pipeline/ and prints each hop as PASS, FAIL or NONE (no harness yet: real debt) with its timing.
 *
 *   node packages/gate/src/io/matrix.js [--only <harness>[,<harness>…]] [--live [--since 2h]] [--against <commit>] [--json]
 *
 * --live reads this board's gate-health receipts (read only) and marks each row current only when its harness
 * passes and the live receipt agrees. --against runs the same harnesses on an older commit's tree, which each harness
 * extracts into its own scratch folder, so a repro shows it fails on the old behaviour. --json prints the report a
 * view screen renders.
 *
 * Why a matrix: on 8 Nov about ten gate fixes landed and gate deaths fell, partly because fewer builders ran; nothing
 * proved any hop worked. A row is a claim only when a harness proves it and production agrees.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  join,
  resolve,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

const fs = fileSystemAdapter();

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
/** The CLI entry the package manifest names as its pullboard bin, so this file names no app path. */
const CLI = join(ROOT, JSON.parse(fs.readFile(join(ROOT, 'package.json'), 'utf8')).bin.pullboard);
const HARNESSES = join(ROOT, 'packages/gate/tests/fixtures/pipeline');

/** Where each harness name lives under the pipeline folder, since the layout move gave the files shorter names. */
export const HARNESS_FILES = Object.freeze({
  'analysis-on-runner': 'analysis-on-runner', 'board-commands': 'board/commands', 'board-write': 'board/write', e2e: 'e2e',
  'landing-reopen': 'a-reject-or-reopen-during-landing', 'import-undeclared': 'board-restored-from-an-export-with-an-un', 'merged-twice': 'pullboard-merged-run-twice', 'proof-lanes': 'lanes', 'shout-scope': 'a-shout-names-an-item-this-seat-cannot-a', 'next-claim-fresh': 'next-resumes-a-claim-that-changed-in-the',
  'red-at-claim': 'a-red-from-an-older-head-shown-at-claim', 'landing-run': 'landing-run-fails-or-its-proof-is-not-gr', 'sleep-past-leases': 'machine-sleeps-past-every-lease', 'main-test': 'queued-main-test-job-never-driven', 'red-notice': 'red-notice-after-the-claim-lapsed', 'review-held': 'review-held-on-an-item-that-was-withdraw',
  'ready-budget': 'budget',
});

/** Board command latency target per command, from the 2 Nov speed rule. */
const COMMAND_TARGET_MS = 200;

/**
 * Every hop, in pipeline order. `harness` names the file HARNESS_FILES names under packages/gate/tests/fixtures/pipeline, or null when none
 * exists. `live` reads the hop's production receipt from a gate-health report: it returns what was seen and whether
 * it agrees with the invariant, or null when the report says nothing about the hop. `fix` names the commit a repro
 * row's harness must fail before.
 */
export const HOPS = Object.freeze([
  { id: 'claim', stage: 'Build', hop: 'claim', harness: 'e2e',
    invariant: 'A claim leases the item to one seat and freezes its criterion.' },
  { id: 'submit-queued', stage: 'Gate', hop: 'submit → queued', harness: 'e2e',
    invariant: 'Submit returns with the gate queued on the submitted commit; it never waits on the gate.',
    live: report => phase(report, 'queued', null) },
  { id: 'analysis-on-runner', stage: 'Gate', hop: 'analysis job on runner', harness: 'analysis-on-runner',
    invariant: 'Authorization, cells, doctrine and static run as one runner job and return their artifact.',
    live: report => phase(report, 'remote-analysis', null) },
  { id: 'runner-admission', stage: 'Gate', hop: 'runner admission', harness: 'ready-budget',
    invariant: 'With a free slot, a gate is admitted to a runner in under 1 s.',
    live: report => phase(report, 'admission', 1_000) },
  { id: 'orphan-worker', stage: 'Gate', hop: 'orphaned runner worker is reclaimed', harness: 'orphan-worker', fix: '6166bf85ca',
    invariant: 'The idle probe stops a runner worker its controller no longer names and proves the runner idle again.' },
  { id: 'ready-budget', stage: 'Gate', hop: 'dispatch → READY', harness: 'ready-budget', fix: '8f7c4c7024',
    invariant: 'A dispatch reaches READY on its first attempt with a full startup budget, even after a long analysis.',
    live: report => cause(report, 'admission-deadline') },
  { id: 'proof-lanes', stage: 'Gate', hop: 'proof shards: at most 3 lanes', harness: 'proof-lanes', fix: 'cc0a573570',
    invariant: 'One gate runs at most 3 runner-controllers at once, however many slots are free.' },
  { id: 'runner-spec', stage: 'Gate', hop: 'proof shards: spec under 1 MiB', harness: 'runner-spec', fix: '2640738102',
    invariant: 'A runner request naming every test file of this repository builds a spec under 1 MiB.' },
  { id: 'test-receipt', stage: 'Gate', hop: 'test run → receipt', harness: 'e2e',
    invariant: 'A green gate leaves a proof receipt naming the submitted commit.',
    live: report => phase(report, 'result', null) },
  { id: 'green-review', stage: 'Review', hop: 'green → review', harness: 'e2e',
    invariant: 'A green gate puts the item in review, waiting on an independent reviewer.' },
  { id: 'accept-merged', stage: 'Land', hop: 'accept → landing batch → merged', harness: 'e2e',
    invariant: 'An accept lands through a batch: main moves to the recorded merge and is pushed.' },
  { id: 'landing-reopen', stage: 'Land', hop: 'reject or reopen during landing', harness: 'landing-reopen',
    invariant: 'An item reopened between selection and merge drops out of the landing batch: main never takes its commit and it records no merge.' },
  { id: 'shout-scope', stage: 'All', hop: 'a shout names an item this seat cannot act on', harness: 'shout-scope',
    invariant: 'A shout ends next --wait only for an item open in the seat\'s lane, claimed by it or reservable by it; any other shout is printed and the wait goes on.' },
  { id: 'next-claim-fresh', stage: 'All', hop: 'next resumes a claim that changed in the same moment', harness: 'next-claim-fresh',
    invariant: 'next prints you hold #N only after re-reading, in the read that prints, that the seat holds #N with a live lease; a lapsed lease selects again.' },
  { id: 'merged-twice', stage: 'Land', hop: 'pullboard merged run twice', harness: 'merged-twice',
    invariant: 'A second merged for a recorded item appends nothing and names the record; a different commit is refused MERGED_ALREADY.' },
  { id: 'command-latency', stage: 'All', hop: 'board command latency', harness: 'board-commands',
    invariant: `Seat commands answer in under ${COMMAND_TARGET_MS} ms, and none loads more modules than its ratcheted ceiling.`,
    live: (report, extra) => extra.statusMs === undefined ? null
      : { seen: `pullboard status ${Math.round(extra.statusMs)} ms`, agrees: extra.statusMs < COMMAND_TARGET_MS } },
  { id: 'board-write', stage: 'All', hop: 'board write never queues', harness: 'board-write', fix: '58f204a4af',
    invariant: 'A write in a busy checkout answers, and holds the board lock under 1 s, past a slow same-session command, a long reader, a gate worker and dead holders.' },
  { id: 'import-undeclared', stage: 'All', hop: 'board restored from an export with an undeclared status', harness: 'import-undeclared',
    invariant: 'An import whose item row carries an undeclared status is refused UNDECLARED_STATE before anything is inserted.' },
  { id: 'red-at-head', stage: 'Build', hop: 'red gate at the current head is shown at claim', harness: 'red-at-claim',
    invariant: 'A red gate is handed back at claim when it ran on the item\'s current commit.' },
  { id: 'red-older-head', stage: 'Build', hop: 'red gate from an older head is not shown at claim', harness: 'red-at-claim',
    invariant: 'A red gate that ran on an older head is never handed back once the item moved to a new commit.' },
  { id: 'landing-run-throws', stage: 'Land', hop: 'landing run that throws ends failed', harness: 'landing-run',
    invariant: 'A landing run that throws ends failed with its lease freed, and the next landing starts.' },
  { id: 'landing-run-stalled', stage: 'Land', hop: 'landing run with a stalled batch ends failed', harness: 'landing-run',
    invariant: 'A landing run whose batch stalled, so its proof is not green, ends failed with its lease freed.' },
  { id: 'sleep-past-leases', stage: 'Gate', hop: 'machine sleeps past every lease', harness: 'sleep-past-leases',
    invariant: 'After a sleep past every lease, the fallback ends the job whose item moved on and drives only the live one.' },
  { id: 'main-test-offered', stage: 'Gate', hop: 'queued main-test job is offered or ended', harness: 'main-test',
    invariant: 'A queued main-test job is offered at its main commit, or ended unoffered with why: none stays queued.' },
  { id: 'main-test-lapsed', stage: 'Gate', hop: 'taken main-test job is renewed or lapses', harness: 'main-test',
    invariant: 'A main-test job a runner took is renewed while it runs, and listed as lapsed once its lease runs out.' },
  { id: 'red-notice-live', stage: 'Build', hop: 'red notice for a live claim', harness: 'red-notice',
    invariant: 'A red notice for a live claim says it stays claimed until the lease.' },
  { id: 'red-notice-lapsed', stage: 'Build', hop: 'red notice after the claim lapsed', harness: 'red-notice',
    invariant: 'A red notice read after the lease ran out says the claim lapsed, never that it stays claimed.' },
  { id: 'review-held-verdict', stage: 'Review', hop: 'review job ends with a verdict', harness: 'review-held',
    invariant: 'A verdict ends the item\'s review job in the same transaction, freeing its lease.' },
  { id: 'review-held-withdraw', stage: 'Review', hop: 'review job ends with a withdraw', harness: 'review-held',
    invariant: 'A withdraw ends the item\'s review job in the same transaction, freeing its lease.' },
  { id: 'review-held-reopen', stage: 'Review', hop: 'review job ends with a reopen', harness: 'review-held',
    invariant: 'A reopen ends the item\'s review job in the same transaction, freeing its lease.' },
]);

/**
 * A live receipt from one gate-health phase: its p50 over the window, agreeing when it is under `boundMs`.
 *
 * @param {{ phases?: { phase: string, gates: number, p50Ms: number }[] }} report
 * @param {string} name
 * @param {number | null} boundMs - Null when the phase has no bound and is shown as evidence only.
 * @returns {{ seen: string, agrees: boolean | null } | null}
 */
function phase(report, name, boundMs) {
  const row = report.phases?.find(entry => entry.phase === name);
  if (!row) return null;
  return { seen: `${name} p50 ${duration(row.p50Ms)} over ${row.gates} gates`, agrees: boundMs === null ? null : row.p50Ms < boundMs };
}

/**
 * A live receipt from one gate-health failure cause: agreeing only when the window shows none.
 *
 * @param {{ causes?: { code: string, count: number }[] }} report
 * @param {string} code
 * @returns {{ seen: string, agrees: boolean }}
 */
function cause(report, code) {
  const count = (report.causes ?? []).filter(entry => entry.code === code).reduce((sum, entry) => sum + entry.count, 0);
  return { seen: `${count} ${code}`, agrees: count === 0 };
}

/**
 * A short human duration.
 *
 * @param {number | null} ms
 * @returns {string}
 */
function duration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1_000)).padStart(2, '0')}s`;
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{ only: string[] | null, live: boolean, since: string, against: string | null, json: boolean }}
 */
export function parseArgs(argv) {
  const options = { only: null, live: false, since: '2h', against: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only') options.only = String(argv[++index] ?? '').split(',').filter(Boolean);
    else if (arg === '--live') options.live = true;
    else if (arg === '--since') options.since = String(argv[++index] ?? '2h');
    else if (arg === '--against') options.against = String(argv[++index] ?? '');
    else if (arg === '--json') options.json = true;
    else throw Object.assign(new Error(`unknown argument ${arg}; usage: node packages/gate/src/io/matrix.js [--only <harness>] [--live [--since 2h]] [--against <commit>] [--json]`), { code: 'USAGE' });
  }
  return options;
}

/** The prefix of the machine-readable row a harness prints for each hop it measured. */
const ROW_MARK = '# hop-row ';

/** Harnesses the owning app holds, by hop harness name: repository-relative paths kept as data so this package names no app file. */
export const APP_HARNESSES = Object.freeze(JSON.parse(fs.readFile(join(ROOT, 'packages/gate/data/tests/app-harnesses.json'), 'utf8')));

/** The absolute path of one harness file: under the owning app when APP_HARNESSES names it, else under the pipeline folder. */
export function harnessFile(name) {
  return APP_HARNESSES[name] ? join(ROOT, APP_HARNESSES[name]) : join(HARNESSES, `${HARNESS_FILES[name] ?? name}.js`);
}

/**
 * Run one harness file in its own process and collect the hop rows it printed.
 *
 * @param {string} name - The harness name.
 * @param {{ against: string | null }} options - The older commit to run against, when any.
 * @returns {Promise<{ name: string, code: number | null, ms: number, rows: object[], tail: string }>}
 */
function runHarness(name, { against }) {
  const started = performance.now();
  const env = { ...process.env, ...(against ? { PULLBOARD_HOP_AGAINST: against } : {}) };
  const child = spawn(process.execPath, ['--no-warnings', harnessFile(name)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rows = [];
  let output = '', pending = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output = (output + chunk).slice(-20_000);
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.startsWith(ROW_MARK)) rows.push(JSON.parse(line.slice(ROW_MARK.length)));
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20_000); });
  return new Promise(resolveRun => {
    child.once('close', code => resolveRun({ name, code, ms: performance.now() - started, rows, tail: output }));
  });
}

/**
 * The first failure line a harness printed, for a hop it never reached.
 *
 * @param {string} tail
 * @returns {string}
 */
function firstFailure(tail) {
  if (/outlives it by/u.test(tail)) return 'a process the harness started outlived it';
  const line = tail.split('\n').find(text => /^\s+error: '|Error: /u.test(text));
  return (line ?? tail.trim().split('\n').at(-1) ?? 'harness failed').trim().replace(/^error: /u, '').slice(0, 200);
}

/**
 * Join each hop with its harness run and live receipt into the report rows.
 *
 * @param {Map<string, Awaited<ReturnType<typeof runHarness>>>} runs
 * @param {object | null} live - The gate-health report, when --live.
 * @param {{ statusMs?: number }} extra - Other live measurements.
 * @returns {object[]}
 */
export function matrixRows(runs, live, extra = {}) {
  return HOPS.map(hop => {
    const run = hop.harness ? runs.get(hop.harness) : null;
    const reported = run?.rows.find(row => row.hop === hop.id);
    const leaked = run && run.code !== 0 && /outlives it by/u.test(run.tail);
    let status = 'NONE', ms = null, measured = '', why = '';
    if (hop.harness && !run) status = 'SKIPPED';
    else if (reported) ({ status, ms, measured, cause: why } = reported);
    else if (run) { status = 'FAIL'; why = firstFailure(run.tail); }
    if (status === 'PASS' && leaked) { status = 'FAIL'; why = 'a process the harness started outlived it'; }
    const receipt = live && hop.live ? hop.live(live, extra) : null;
    const current = status === 'PASS' && (receipt === null || receipt.agrees !== false);
    return { id: hop.id, stage: hop.stage, hop: hop.hop, invariant: hop.invariant,
      harness: hop.harness ? `packages/gate/tests/fixtures/pipeline/${hop.harness}.harness.js` : null, fix: hop.fix ?? null,
      status, ms, measured, cause: why || '', live: receipt, current: live ? current : null };
  });
}

/**
 * Render the rows as the terminal table.
 *
 * @param {object[]} rows
 * @param {{ at: string, against: string | null, live: boolean }} meta
 * @returns {string}
 */
export function renderMatrix(rows, meta) {
  const lines = [`pipeline hop matrix, ${meta.at}${meta.against ? `, against ${meta.against}` : ''}`];
  const width = Math.max(...rows.map(row => row.hop.length));
  for (const row of rows) {
    const time = row.ms === null ? '' : duration(row.ms);
    const detail = row.status === 'NONE' ? 'no harness' : [row.measured, row.cause].filter(Boolean).join('; ');
    const live = !meta.live ? '' : row.live ? `  live: ${row.live.seen}${row.live.agrees === false ? ' (disagrees)' : ''}` : '  live: no receipt';
    lines.push(`  ${row.hop.padEnd(width)}  ${row.status.padEnd(7)} ${time.padStart(7)}  ${detail}${live}`);
  }
  const count = status => rows.filter(row => row.status === status).length;
  lines.push(`${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('NONE')} NONE${meta.live ? `; ${rows.filter(row => row.current).length} current (harness passes and live agrees)` : ''}`);
  return lines.join('\n');
}

/**
 * Read this board's gate-health report and time one read command, both read only.
 *
 * @param {string} since
 * @returns {{ report: object | null, statusMs: number | undefined }}
 */
function liveReceipts(since) {
  const health = spawnSync(process.execPath, [CLI, 'gate-health', '--since', since, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
  let report = null;
  try { report = health.status === 0 ? JSON.parse(health.stdout).report : null; }
  catch (error) { process.stderr.write(`gate-health answered unreadable JSON: ${error.message}\n`); }
  const started = performance.now();
  const status = spawnSync(process.execPath, [CLI, 'status'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  return { report, statusMs: status.status === 0 ? performance.now() - started : undefined };
}

/**
 * Run the matrix: every harness one after another, so each timing is measured alone, then print it.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} The exit code: 0 when no hop with a harness failed.
 */
export async function main(argv) {
  const options = parseArgs(argv);
  const names = [...new Set(HOPS.map(hop => hop.harness).filter(Boolean))].filter(name => !options.only || options.only.includes(name));
  if (!fs.exists(HARNESSES)) {
    process.stderr.write(`no harnesses at ${HARNESSES}; they ship in the repository, not the package\n`);
    return 1;
  }
  const runs = new Map();
  for (const name of names) {
    if (!options.json) process.stderr.write(`running ${name}…\n`);
    runs.set(name, await runHarness(name, { against: options.against }));
  }
  const live = options.live ? liveReceipts(options.since) : { report: null };
  const rows = matrixRows(runs, live.report, { statusMs: live.statusMs });
  const meta = { at: new Date().toISOString(), against: options.against, live: options.live };
  if (options.json) process.stdout.write(JSON.stringify({ version: 1, ...meta, rows }, null, 2) + '\n');
  else process.stdout.write(renderMatrix(rows, meta) + '\n');
  return rows.some(row => row.status === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`hop-matrix: ${error.code ? `[${error.code}] ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}
