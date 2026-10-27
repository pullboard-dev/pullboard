/** Read the economics of recorded test executions without changing test admission [C7]. */
import { readdirSync } from 'node:fs';
import { events } from './board.js';
import { proofEventDetail } from './proof-event-detail.js';
import {
  boardReceiptStore,
  readGateReceipt,
} from './gate-run-receipt.js';
import { readTestValueTimings } from './test-value-timing.js';
import { flakeLedger } from './flakes.js';
import { eventCauses } from './rigor.js';
import { tryGit } from './git.js';

const DAY = 86_400_000;
const TEST = /(?:^|\/)(?:test|tests|fixtures?)(?:\/|$)|\.(?:test|spec)\.[cm]?js$/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Reject foreign paths instead of using report evidence as a filesystem or Git argument. */
function portable(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 4096
    && !/[\r\n\0\\]/u.test(file) && !file.startsWith('/') && !/^[A-Za-z]:/u.test(file)
    && !file.split('/').some(part => !part || part === '.' || part === '..');
}

/** Keep malformed legacy detail visibly absent rather than interpreting prose as evidence. */
function detail(event) {
  try { return proofEventDetail(event) ?? {}; } catch { return {}; }
}

/** Read native disk receipts and replicated proof events once, keyed by execution receipt id. */
function executions(board, history) {
  const store = boardReceiptStore(board);
  const runs = new Map();
  if (store) {
    let names = [];
    try { names = readdirSync(store); } catch { /* An absent local store is ordinary on replicas. */ }
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const receipt = readGateReceipt(store, name.slice(0, -5));
      if (!receipt) continue;
      const proof = receipt.proof;
      runs.set(receipt.id, { id: receipt.id, kind: receipt.kind, at: receipt.at, commit: receipt.head, tree: receipt.tree,
        item: proof?.item ?? null, clean: proof ? proof.sourceClean : true,
        green: receipt.green, exit: proof?.exitCode ?? (receipt.green ? 0 : 1),
        workers: proof?.testRuntimes ?? [], failures: receipt.failures });
    }
  }
  for (const event of history) {
    const receipt = detail(event).receipt;
    if (event.event_kind !== 'proof-run' || !receipt || !/^[a-f0-9-]{36}$/u.test(receipt.id ?? '')) continue;
    // Replicated receipts survive cleanup of a builder's worktree and private logs.
    const existing = runs.get(receipt.id);
    runs.set(receipt.id, { id: receipt.id, kind: receipt.kind, at: receipt.at, commit: receipt.commit, tree: receipt.tree,
      item: receipt.item, clean: receipt.sourceClean === true,
      green: receipt.exitCode === 0, exit: receipt.exitCode,
      workers: receipt.testRuntimes ?? [], failures: existing?.failures ?? [] });
  }
  for (const run of runs.values()) {
    const sample = store ? readTestValueTimings(store, run.id) : null;
    run.timings = sample?.files ?? [];
    run.tests = sample?.tests ?? [];
    const workers = Array.isArray(run.workers) ? run.workers : [];
    run.files = new Map();
    const pids = new Set();
    for (const worker of workers) {
      const key = JSON.stringify([worker?.pid, worker?.file, worker?.environment]);
      if (!portable(worker?.file) || !Number.isSafeInteger(worker.pid) || pids.has(key)) continue;
      pids.add(key);
      run.files.set(worker.file, (run.files.get(worker.file) ?? 0) + 1);
    }
    // Old full-gate receipts have no worker inventory; retained per-file measurements still prove those runs.
    for (const row of run.timings) if (!run.files.has(row.file)) {
      run.files.set(row.file, run.timings.filter(value => value.file === row.file).length);
    }
  }
  return [...runs.values()];
}

/** Read committed test names and per-file edit counts in one traversal of this checkout's history. */
function sourceHistory(root, since, until) {
  const tracked = tryGit(root, ['ls-files', '-z']);
  const files = tracked.status === 0 ? tracked.stdout.split('\0').filter(file => portable(file) && /\.(?:test|spec)\.[cm]?js$/u.test(file)) : [];
  const log = tryGit(root, ['log', '--format=commit:%H', '--name-only', '--no-renames', `--since=${since}`, `--until=${until}`, 'HEAD', '--']);
  const edits = new Map();
  let seen = new Set();
  if (log.status === 0) for (const line of log.stdout.split('\n')) {
    if (/^commit:[a-f0-9]+$/u.test(line)) { seen = new Set(); continue; }
    if (!portable(line) || seen.has(line)) continue;
    seen.add(line);
    edits.set(line, (edits.get(line) ?? 0) + 1);
  }
  return { files, edits, available: tracked.status === 0 && log.status === 0 };
}

/** Require a real ancestor repair, unchanged test/fixture bytes and a product-code delta. */
function codeRepair(root, red, green, file) {
  if (!SHA.test(red ?? '') || !SHA.test(green ?? '') || red === green) return false;
  if (tryGit(root, ['merge-base', '--is-ancestor', red, green]).status !== 0) return false;
  const changed = tryGit(root, ['diff', '--name-only', '-z', '--no-renames', red, green, '--']);
  if (changed.status !== 0) return false;
  const paths = changed.stdout.split('\0').filter(Boolean);
  if (paths.some(path => path === file || TEST.test(path))) return false;
  return paths.some(path => portable(path) && /^(?:src|relay|bin)\//u.test(path) && /\.[cm]?[jt]sx?$/u.test(path));
}

/** Extract only typed, non-conflict test identities; free-text reviewer notes are never parsed. */
function failureTests(event) {
  const value = detail(event);
  if (!['reject', 'reopen'].includes(event.event_kind) || value.conflict) return [];
  let causes;
  try { causes = eventCauses(event); } catch { return []; }
  return causes.flatMap(cause => {
    const match = /^test:([^:]+)::(.+)$/u.exec(cause);
    return match && portable(match[1]) ? [{ file: match[1], name: match[2] }] : [];
  });
}

/** Identify linked code repairs, retaining the failure receipt and later accepted green as provenance. */
function catches(root, history, runs, flaky, from, until) {
  const found = new Map();
  const unresolved = new Map();
  const repairCache = new Map();
  for (const event of history) {
    const at = Date.parse(event.event_at);
    if (at < from || at > until || !Number.isFinite(at)) continue;
    for (const test of failureTests(event)) {
      const value = detail(event);
      const head = value.commit ?? value.landingFailure?.commit;
      const red = runs.find(run => run.clean && run.exit !== null && run.exit !== undefined && run.exit !== 0
        && run.commit === head && run.files.has(test.file) && Date.parse(run.at) >= from && Date.parse(run.at) <= at
        && (run.failures.some(value => value.file === test.file && value.name === test.name)
          || run.tests.some(value => value.file === test.file && value.name === test.name && !value.passed)));
      const episode = JSON.stringify([test.file, test.name, red?.tree ?? head ?? event.event_id]);
      if (found.has(episode)) continue;
      const flakyHead = flaky.some(row => row.file === test.file && row.name === test.name && row.head === head);
      if (flakyHead) continue;
      const accepted = history.filter(later => later.item_id === event.item_id && later.event_kind === 'accept'
        && later.event_id > event.event_id && Date.parse(later.event_at) <= until);
      let green;
      for (const accept of accepted) {
        const commit = detail(accept).commit;
        const candidate = runs.find(run => run.clean && run.green && run.commit === commit
          && run.item === event.item_id && run.files.has(test.file) && Date.parse(run.at) <= Date.parse(accept.event_at)
          && Date.parse(run.at) > at
          && run.tests.some(value => value.file === test.file && value.name === test.name && value.passed));
        if (!red || !candidate) continue;
        const key = JSON.stringify([head, commit, test.file]);
        if (!repairCache.has(key)) repairCache.set(key, codeRepair(root, head, commit, test.file));
        if (repairCache.get(key)) { green = candidate; break; }
      }
      if (red && green) {
        found.set(episode, { ...test, item: event.item_id, causeEvent: event.event_id, red: red.id, green: green.id,
          redCommit: red.commit, greenCommit: green.commit });
        unresolved.delete(episode);
      } else if (!found.has(episode)) unresolved.set(episode, test);
    }
  }
  return { found: [...found.values()], unresolved: [...unresolved.values()] };
}

/** Project a consistent fourteen-day board snapshot; unknown measurements stay unknown. */
export function testValueReport(board, { root, costs, now = Date.now() }) {
  const until = Number(now);
  const from = until - 14 * DAY;
  const since = new Date(from).toISOString();
  const asOf = new Date(until).toISOString();
  const history = events(board);
  const runs = executions(board, history).filter(run => Number.isFinite(Date.parse(run.at)) && Date.parse(run.at) <= until);
  const windowRuns = runs.filter(run => Date.parse(run.at) >= from);
  const source = sourceHistory(root, since, asOf);
  const observations = flakeLedger(board).flatMap(row => row.observations)
    .filter(row => row.classification === 'flake' && Date.parse(row.at) >= from && Date.parse(row.at) <= until);
  const repairs = catches(root, history, runs, observations, from, until);
  const rows = new Map();
  /** Initialize every tracked or observed file, including files with no measured run. */
  const entry = file => {
    if (!rows.has(file)) rows.set(file, { file, runs: 0, realCatches: 0, flakes: 0, runtimeMs: null,
      timedRuns: 0, meanRuntimeMs: null, edits: source.available ? source.edits.get(file) ?? 0 : null,
      catchRate: null, flakeRate: null, valuePerRun: null, catchRuns: 0, flakeRuns: 0,
      unmatchedFlakes: 0, unattributedFailures: 0, catches: [], receiptIds: [] });
    return rows.get(file);
  };
  for (const file of source.files) entry(file);
  let unknownFileReceipts = 0;
  for (const run of windowRuns) {
    if (!run.files.size) unknownFileReceipts += 1;
    for (const [file, count] of run.files) {
      const row = entry(file);
      row.runs += count;
      row.receiptIds.push(run.id);
      const timings = run.timings.filter(value => value.file === file);
      // A partial set of file measurements never becomes a complete mean for this receipt.
      if (timings.length === count) {
        row.runtimeMs = (row.runtimeMs ?? 0) + timings.reduce((sum, value) => sum + value.durationMs, 0);
        row.timedRuns += count;
      }
    }
  }
  const flakeRuns = new Set();
  const matchedFlakes = new Set();
  for (const observation of observations) {
    const key = JSON.stringify([observation.file, observation.head, observation.original.sha256]);
    if (flakeRuns.has(key) || !portable(observation.file)) continue;
    flakeRuns.add(key);
    const row = entry(observation.file);
    row.flakes += 1;
    const candidates = windowRuns.filter(run => run.clean && !run.green && run.commit === observation.head
      && run.files.has(observation.file) && Date.parse(run.at) <= Date.parse(observation.at)
      && (run.tests.some(test => test.file === observation.file && test.name === observation.name && !test.passed)
        || run.failures.some(test => test.file === observation.file && test.name === observation.name)));
    // Historical observations lack a native receipt id: ambiguity remains explicit.
    if (candidates.length === 1) matchedFlakes.add(JSON.stringify([observation.file, candidates[0].id]));
    else row.unmatchedFlakes += 1;
  }
  for (const repair of repairs.found) { const row = entry(repair.file); row.realCatches += 1; row.catches.push(repair); }
  for (const failure of repairs.unresolved) entry(failure.file).unattributedFailures += 1;
  for (const row of rows.values()) {
    row.catchRuns = new Set(row.catches.map(value => value.red)).size;
    row.flakeRuns = [...matchedFlakes].filter(value => JSON.parse(value)[0] === row.file).length;
    if (row.runs > 0) {
      row.catchRate = row.unattributedFailures ? null : row.catchRuns / row.runs;
      row.flakeRate = row.unmatchedFlakes ? null : row.flakeRuns / row.runs;
      if (row.timedRuns === row.runs) row.meanRuntimeMs = row.runtimeMs / row.runs;
      if (row.meanRuntimeMs !== null && row.catchRate !== null && row.flakeRate !== null) row.valuePerRun = row.catchRate * costs.costOfEscape
        - row.meanRuntimeMs / 1000 * costs.costOfWaiting - row.flakeRate * costs.costOfFalseRed;
    }
  }
  const files = [...rows.values()].sort((left, right) => (left.valuePerRun === null) - (right.valuePerRun === null)
    || (right.valuePerRun ?? 0) - (left.valuePerRun ?? 0) || left.file.localeCompare(right.file));
  return { since, asOf, days: 14, costs, files,
    coverage: { receipts: windowRuns.length, unknownFileReceipts, gitHistoryAvailable: source.available },
    method: 'Descriptive observed catch/flake rates per recorded file execution. Real catches require a typed failure, exact named red and green outcomes, later acceptance, unchanged tests/fixtures and a product-code delta. A flake is associated only with a unique matching same-head named red; ambiguous sightings keep its rate unknown. Runtime is measured file wall time rather than gate queue time, and is unknown when incomplete. Costs use seconds of equivalent waiting. Missing history is not proof of no defects; identical worker identities cannot prove additional executions. Report only: no test selection or gate policy changes.' };
}
