/** Read the economics of recorded test executions without changing test admission [C7]. */
import { readFileTimes } from './value/timing.js';
import { bindTestValueSources } from '../../logic/test/source.js';
import { readdirSync } from 'node:fs';
import { events } from '../../../../store/index.js';
import { proofEventDetail } from '../../../../kernel/index.js';
import {
  boardReceiptStore,
  readGateReceipt,
  receiptFields,
} from '../run/receipt.js';
import { readTestValueTimings } from './value/timing.js';
import { tryGit } from '../../../../git/index.js';

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
        durationMs: proof?.durationMs ?? null, workers: proof?.testRuntimes ?? [], failures: receipt.failures, collection: receipt.collection });
    }
  }
  for (const event of history) {
    const audit = event.event_kind === 'gate-run' ? receiptFields(detail(event).run) : null;
    if (audit?.kind === 'land' && audit.collection?.complete === true && event.event_by === 'coordinator') {
      const existing = runs.get(audit.id);
      runs.set(audit.id, { ...existing, id: audit.id, kind: audit.kind, at: audit.at, commit: audit.head, tree: audit.tree,
        item: null, clean: true, green: audit.green, exit: audit.green ? 0 : 1, durationMs: null,
        workers: [], failures: audit.failures, collection: audit.collection, auditEventId: event.event_id });
    }
    const receipt = detail(event).receipt;
    if (event.event_kind !== 'proof-run' || !receipt || !/^[a-f0-9-]{36}$/u.test(receipt.id ?? '')) continue;
    // Replicated receipts survive cleanup of a builder's worktree and private logs.
    const existing = runs.get(receipt.id);
    runs.set(receipt.id, { id: receipt.id, kind: receipt.kind, at: receipt.at, commit: receipt.commit, tree: receipt.tree,
      item: receipt.item, clean: receipt.sourceClean === true,
      green: receipt.exitCode === 0, exit: receipt.exitCode,
      durationMs: receipt.durationMs ?? null, workers: receipt.testRuntimes ?? [], failures: existing?.failures ?? [] });
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
    // A complete audit names its exact completed file plan even after private timing sidecars are gone.
    if (run.auditEventId && run.collection?.complete) for (const file of run.collection.files) {
      if (!run.files.has(file)) run.files.set(file, 1);
    }
    run.observedFileExecutions = [...run.files.values()].reduce((sum, count) => sum + count, 0);
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
function failureTests(event, eventCauses) {
  const value = detail(event);
  if (!['reject', 'reopen'].includes(event.event_kind) || value.conflict) return [];
  let causes;
  try { causes = eventCauses(event); } catch { return []; }
  return causes.flatMap(cause => {
    const match = /^test:([^:]+)::(.+)$/u.exec(cause);
    return match && portable(match[1]) ? [{ file: match[1], name: match[2] }] : [];
  });
}

/** A routed native audit failure earns a catch immediately, bound to its exact batch, test blob and named red. */
function auditCatches(root, history, runs, flaky, from, until) {
  const found = new Map();
  for (const event of history) {
    const at = Date.parse(event.event_at), defect = detail(event).defect;
    if (event.event_kind !== 'landing-test-defect' || event.event_by !== 'coordinator' || !defect?.audit
      || at < from || at > until || !Number.isFinite(at) || !portable(defect.test) || !Array.isArray(defect.names)) continue;
    const candidates = runs.filter(run => run.auditEventId < event.event_id && run.collection?.batchId === defect.batchId
      && run.clean && !run.green && run.files.has(defect.test) && Date.parse(run.at) >= from && Date.parse(run.at) <= at)
      .sort((a, b) => b.auditEventId - a.auditEventId);
    const red = candidates.find(run => tryGit(root, ['rev-parse', `${run.commit}:${defect.test}`]).stdout.trim() === defect.blob);
    if (!red) continue;
    for (const name of defect.names) {
      if (!red.failures.some(test => test.file === defect.test && test.name === name)
        || flaky.some(row => row.file === defect.test && row.name === name && row.head === red.commit)) continue;
      const key = JSON.stringify([defect.test, name, red.tree]);
      if (!found.has(key)) found.set(key, { file: defect.test, name, item: defect.item, causeEvent: event.event_id,
        red: red.id, green: null, redCommit: red.commit, greenCommit: null, source: 'audit', batchId: defect.batchId });
    }
  }
  return found;
}

/** Identify linked code repairs and routed audit catches, preserving each evidence source without inventing a repair. */
function catches(root, history, runs, flaky, from, until, eventCauses) {
  const found = auditCatches(root, history, runs, flaky, from, until);
  const unresolved = new Map();
  const repairCache = new Map();
  for (const event of history) {
    const at = Date.parse(event.event_at);
    if (at < from || at > until || !Number.isFinite(at)) continue;
    for (const test of failureTests(event, eventCauses)) {
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
export function testValueReport(board, { root, costs, now = Date.now() }, services) {
  if (!['flakeLedger', 'eventCauses'].every(name => typeof services?.[name] === 'function')) throw new TypeError('test value needs explicit flake ledger and cause readers');
  const { flakeLedger, eventCauses } = services;
  const until = Number(now);
  const from = until - 14 * DAY;
  const since = new Date(from).toISOString();
  const asOf = new Date(until).toISOString();
  const history = events(board);
  const runs = executions(board, history).filter(run => Number.isFinite(Date.parse(run.at)) && Date.parse(run.at) <= until);
  const windowRuns = runs.filter(run => Date.parse(run.at) >= from);
  const sourceCoverage = bindTestValueSources(root, windowRuns);
  const lastFileTimes = readFileTimes(root);
  const source = sourceHistory(root, since, asOf);
  const observations = flakeLedger(board).flatMap(row => row.observations)
    .filter(row => row.classification === 'flake' && Date.parse(row.at) >= from && Date.parse(row.at) <= until);
  const repairs = catches(root, history, runs, observations, from, until, eventCauses);
  const rows = new Map();
  /** Initialize every tracked or observed file, including files with no measured run. */
  const entry = file => {
    if (!rows.has(file)) rows.set(file, { file, runs: 0, realCatches: 0, flakes: 0, runtimeMs: null,
      timedRuns: 0, namedOutcomeRuns: 0, meanRuntimeMs: null, edits: source.available ? source.edits.get(file) ?? 0 : null,
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
      // Historical named outcomes carry no worker/attempt identity. One sample cannot cover repeated executions.
      if (count === 1 && (run.tests.some(test => test.file === file) || run.auditEventId && run.collection?.complete)) row.namedOutcomeRuns += 1;
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
    if (!rows.has(observation.file)) continue;
    const row = entry(observation.file);
    row.flakes += 1;
    const candidates = windowRuns.filter(run => run.clean && !run.green && run.commit === observation.head
      && run.files.has(observation.file) && Date.parse(run.at) <= Date.parse(observation.at)
      && (run.tests.some(test => test.file === observation.file && test.name === observation.name && !test.passed)
        || run.failures.some(test => test.file === observation.file && test.name === observation.name)));
    // Historical observations lack a native receipt id: ambiguity remains explicit.
    if (candidates.length === 1 && candidates[0].files.get(observation.file) === 1) matchedFlakes.add(JSON.stringify([observation.file, candidates[0].id]));
    else row.unmatchedFlakes += 1;
  }
  for (const repair of repairs.found) { const row = entry(repair.file); row.realCatches += 1; row.catches.push(repair); }
  for (const failure of repairs.unresolved) {
    if (rows.has(failure.file)) entry(failure.file).unattributedFailures += 1;
  }
  for (const row of rows.values()) {
    row.catchRuns = new Set(row.catches.map(value => value.red)).size;
    row.flakeRuns = [...matchedFlakes].filter(value => JSON.parse(value)[0] === row.file).length;
    if (row.runs > 0) {
      row.catchRate = row.unattributedFailures || row.namedOutcomeRuns !== row.runs ? null : row.catchRuns / row.runs;
      row.flakeRate = row.unmatchedFlakes || row.namedOutcomeRuns !== row.runs ? null : row.flakeRuns / row.runs;
      if (row.timedRuns === row.runs) row.meanRuntimeMs = row.runtimeMs / row.runs;
      if (row.meanRuntimeMs !== null && row.catchRate !== null && row.flakeRate !== null) row.valuePerRun = row.catchRate * costs.costOfEscape
        - row.meanRuntimeMs / 1000 * costs.costOfWaiting - row.flakeRate * costs.costOfFalseRed;
    }
  }
  const lastReceipts = new Map();
  for (const run of windowRuns) {
    if (run.observedFileExecutions !== 1 || run.files.size !== 1 || !Number.isFinite(run.durationMs) || run.durationMs < 0) continue;
    const file = run.files.keys().next().value;
    const existing = lastReceipts.get(file);
    if (!existing || Date.parse(run.at) > Date.parse(existing.at)) lastReceipts.set(file, run);
  }
  for (const row of rows.values()) {
    const last = lastFileTimes[row.file];
    const native = lastReceipts.get(row.file);
    row.lastObservedRuntime = native ? { durationMs: native.durationMs, source: 'native-single-file-receipt', receiptId: native.id, ageMs: until - Date.parse(native.at) } : Number.isFinite(last) && last >= 0
      ? { durationMs: last, source: 'landing-file-times', ageMs: null } : null;
    row.estimatedValuePerRun = row.meanRuntimeMs === null && row.lastObservedRuntime && row.catchRate !== null && row.flakeRate !== null
      ? row.catchRate * costs.costOfEscape - row.lastObservedRuntime.durationMs / 1000 * costs.costOfWaiting - row.flakeRate * costs.costOfFalseRed : null;
  }
  const files = [...rows.values()].sort((left, right) => (left.valuePerRun === null) - (right.valuePerRun === null)
    || (right.valuePerRun ?? 0) - (left.valuePerRun ?? 0) || left.file.localeCompare(right.file));
  return { since, asOf, days: 14, costs, files,
    coverage: { receipts: windowRuns.length, unknownFileReceipts, gitHistoryAvailable: source.available, ...sourceCoverage },
    method: 'Descriptive observed catch/flake rates per recorded file execution. Code-fixed catches require a typed failure, exact named red and green outcomes, later acceptance, unchanged tests/fixtures and a product-code delta. A routed complete native audit failure also earns a catch immediately, bound to its batch, named red and committed test blob; it never claims a green repair. A flake is associated only with a unique matching same-head named red; ambiguous sightings keep its rate unknown. Runtime mean is measured file wall time rather than gate queue time, and is unknown when incomplete. Last-observed single-file native receipt wall time or landing-file-times and its value estimate are separate, with unknown age when the store has no timestamp; one sample is never expanded into historical totals. Worker names are bound to tracked test blobs at each receipt commit; historical inventories lack child cwd, so same-path nested-fixture collisions cannot be resolved. Costs use seconds of equivalent waiting. Missing history is not proof of no defects; identical worker identities cannot prove additional executions. Repeated same-file workers lack attempt-bound named outcomes, so catch and flake rates remain unknown even when every duration is present. Report only: no test selection or gate policy changes.' };
}
