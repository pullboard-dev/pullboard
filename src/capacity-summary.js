/** Pure arithmetic over explicit test-work evidence; unknown time never becomes zero [C7]. */

/** Sum observed file execution time, preserving every retry and identifying missing plan coverage. */
function suiteWork(audit, timings) {
  if (!audit) return { minutes: null, knownMinutes: null, receiptId: null, missingFiles: null,
    unavailableReason: 'A complete full native landing audit receipt is required; run the ordinary main audit and retain its per-file timing sidecar.' };
  const rows = timings?.files ?? [];
  const planned = new Set(audit.collection.files);
  const known = rows.filter(row => planned.has(row.file));
  const measured = new Set(known.map(row => row.file));
  const missingFiles = [...planned].filter(file => !measured.has(file));
  const knownMinutes = known.reduce((sum, row) => sum + row.durationMs, 0) / 60_000;
  return { minutes: missingFiles.length ? null : knownMinutes, knownMinutes, receiptId: audit.id,
    source: audit.head, missingFiles, green: audit.green, unavailableReason: missingFiles.length
      ? `Audit ${audit.id} needs measured per-file timing for: ${missingFiles.join(', ')}.` : null };
}

/** Read a native event document without treating malformed observation data as a landing. */
function eventDocument(event) {
  try { return JSON.parse(event.event_detail); } catch { return null; }
}

/** Accept actual Git identities, never arbitrary snapshot labels as merged commits. */
function commitIdentity(value) { return typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value) ? value : null; }

/** Count explicit successful batches once and unmatched manual merge commits at their first native occurrence. */
export function landedBatchCount(history, since, until) {
  const firstMerges = new Map(), latestItemMerge = new Map(), snapshots = new Map(), batches = new Map();
  for (const event of history) {
    const document = eventDocument(event), at = Date.parse(event.event_at);
    if (!document || !Number.isFinite(at)) continue;
    // The most recent snapshot can describe a success, but never proves success on its own.
    if (event.event_kind === 'landing_batch' && typeof document.batch?.id === 'string') {
      const items = Array.isArray(document.batch.items) ? document.batch.items : [];
      snapshots.set(document.batch.id, new Set(items.map(item => commitIdentity(item?.merge)).filter(Boolean)));
    }
    if (event.event_kind === 'merged') {
      const commit = commitIdentity(document.commit);
      if (!commit) continue;
      if (!firstMerges.has(commit)) firstMerges.set(commit, at);
      if (event.item_id !== null && event.item_id !== undefined) latestItemMerge.set(event.item_id, commit);
      continue;
    }
    const batch = event.event_kind === 'landing_batch' && document.batch?.state === 'landed' ? document.batch : null;
    const moved = event.event_kind === 'main-moved' && commitIdentity(document.sha) ? document : null;
    const id = batch?.id ?? moved?.batch;
    if (typeof id !== 'string' || !id) continue;
    const group = batches.get(id) ?? { at, commits: new Set() };
    group.at = Math.min(group.at, at);
    for (const commit of snapshots.get(id) ?? []) group.commits.add(commit);
    const tip = commitIdentity(batch?.tip ?? moved?.sha);
    if (tip) group.commits.add(tip);
    for (const item of Array.isArray(moved?.items) ? moved.items : []) {
      const commit = latestItemMerge.get(item);
      if (commit) group.commits.add(commit);
    }
    batches.set(id, group);
  }
  const covered = new Set();
  let count = 0;
  for (const group of [...batches.values()].sort((a, b) => a.at - b.at)) {
    const fresh = [...group.commits].filter(commit => !covered.has(commit));
    if (group.commits.size && !fresh.length) continue;
    // Explicit batches use their first successful receipt; only unmatched commits use first-merge time.
    if (group.at >= since && group.at <= until) count++;
    for (const commit of group.commits) covered.add(commit);
  }
  for (const [commit, at] of firstMerges) if (!covered.has(commit) && at >= since && at <= until) count++;
  return count;
}

/** Report serial execution work and a declared lower-bound inventory, never parallel elapsed suite time. */
export function capacitySummary({ value, history, latestAudit, timings, inventory }) {
  const knownMinutes = value.files.reduce((sum, row) => sum + (row.runtimeMs ?? 0), 0) / 60_000;
  const missingExecutions = value.files.reduce((sum, row) => sum + Math.max(0, row.runs - row.timedRuns), 0);
  const unknownReceipts = value.coverage.unknownFileReceipts;
  const landings = landedBatchCount(history, Date.parse(value.since), Date.parse(value.asOf));
  const complete = missingExecutions === 0 && unknownReceipts === 0 && value.coverage.receipts > 0;
  const pure = inventory.filter(row => row.kind === 'pure').length;
  const contract = inventory.filter(row => row.kind === 'contract').length;
  return { since: value.since, asOf: value.asOf,
    suite: { ...suiteWork(latestAudit, timings), measure: 'serial sum of measured per-file execution durations, including retries; not elapsed parallel wall time' },
    perLanding: { minutes: complete && landings ? knownMinutes / landings : null,
      knownMinutes, landings, missingExecutions, unknownReceipts, receipts: value.coverage.receipts,
      measure: 'fourteen-day measured test execution work, failed and retried work included, per successful native batch or unmatched distinct merged commit' },
    files: { total: inventory.length, pure, contract, unknown: inventory.length - pure - contract,
      share: inventory.length ? (pure + contract) / inventory.length : null,
      lowerBound: true, measure: 'explicit committed pure/contract declarations; undeclared files remain unknown' } };
}

/** Read only leading declaration comments, never matching examples or executable string contents. */
export function declaredTestBoundary(source) {
  const header = /^(?:#![^\n]*\n)?(?:\s*\/\*[\s\S]*?\*\/|\s*\/\/[^\n]*(?:\n|$))*/u.exec(source)?.[0] ?? '';
  const declarations = [...header.matchAll(/^[ \t]*\*?[ \t]*@pullboard-test-boundary[ \t]+(pure|contract)[ \t]*$/gmu)];
  return declarations.length === 1 ? declarations[0][1] : 'unknown';
}

