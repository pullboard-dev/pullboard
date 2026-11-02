/** Compare native flake evidence to a prior landing snapshot without discarding test identities [C7,T12]. */
const key = row => JSON.stringify([row.file, row.name]);

/**
 * Every active flake must have a live quarantine and filed repair. An increased count is permitted
 * only for identities first observed and quarantined after the previous landing's event boundary.
 * The returned snapshot is recorded with the landing only after publication succeeds.
 */
export function flakeRatchet({ previous = null, observations, quarantines, eventId }) {
  if (!Number.isSafeInteger(eventId) || eventId < 0) throw new TypeError('a ratchet snapshot needs the captured native event boundary');
  if (previous !== null && (previous.version !== 1 || !Number.isSafeInteger(previous.eventId)
    || previous.eventId > eventId || !Array.isArray(previous.quarantines)
    || previous.count !== previous.quarantines.length)) throw new TypeError('invalid previous flake ratchet snapshot');
  const active = quarantines.filter(row => row.status === 'quarantined');
  const byTest = new Map(active.map(row => [key(row), row]));
  const known = new Map(observations.filter(row => row.status === 'active' && row.count > 0).map(row => [key(row), row]));
  const unprotected = [...known].filter(([id]) => !byTest.has(id)).map(([, row]) => ({ file: row.file, name: row.name }));
  const malformed = active.filter(row => !Number.isSafeInteger(row.item) || row.item <= 0);
  const previousKeys = new Set(previous?.quarantines.map(key) ?? []);
  const increases = previous && active.length > previous.quarantines.length
    ? active.filter(row => !previousKeys.has(key(row))).filter(row => {
      const observed = known.get(key(row));
      return !observed || !(observed.lastEventId > previous.eventId) || !(row.eventId > previous.eventId);
    }).map(row => ({ file: row.file, name: row.name })) : [];
  const snapshot = { version: 1, eventId, count: active.length, quarantines: active.map(({ file, name, item }) => ({ file, name, item })) };
  return { snapshot, unprotected, malformed: malformed.map(({ file, name }) => ({ file, name })), unjustified: increases,
    allowed: !unprotected.length && !malformed.length && !increases.length };
}

/** Recognize contradictory per-test verdicts only on the same immutable tree and distinct native runs. */
export function pairedFlakeObservations(runs, { afterEvent = 0 } = {}) {
  const pairs = new Map(), seen = new Set();
  for (const run of runs) {
    if (typeof run.id !== 'string' || !run.id || seen.has(run.id) || !Number.isSafeInteger(run.eventId) || typeof run.tree !== 'string'
      || ['suite', 'main-red'].includes(run.kind) || !Array.isArray(run.testOutcomes)
      || !(run.version === 1 || run.version === 2 && run.proof?.sourceClean === true && [0, 1].includes(run.proof?.exitCode))) continue;
    seen.add(run.id);
    for (const outcome of run.testOutcomes) {
      if (outcome.skipped || typeof outcome.file !== 'string' || typeof outcome.name !== 'string' || typeof outcome.passed !== 'boolean') continue;
      const id = JSON.stringify([run.tree, outcome.file, outcome.name]);
      const pair = pairs.get(id) ?? { file: outcome.file, name: outcome.name, red: null, green: null };
      const side = outcome.passed ? 'green' : 'red';
      if (!pair[side] || pair[side].eventId < run.eventId) pair[side] = { id: run.id, eventId: run.eventId };
      pairs.set(id, pair);
    }
  }
  const observations = new Map();
  for (const pair of pairs.values()) {
    if (!pair.red || !pair.green || pair.red.id === pair.green.id) continue;
    const lastEventId = Math.max(pair.red.eventId, pair.green.eventId);
    if (lastEventId <= afterEvent) continue;
    const id = key(pair), prior = observations.get(id);
    if (!prior || prior.lastEventId < lastEventId) observations.set(id, { file: pair.file, name: pair.name, status: 'active', count: 1, lastEventId });
  }
  return [...observations.values()];
}

/** Reconstruct quarantines at a landing boundary from the ordered native event history. */
export function quarantinesAt(events, runs, { throughEvent, quarantineCoreEngine, autoSubmitEngine }) {
  if (!Number.isSafeInteger(throughEvent) || throughEvent < 0) throw new TypeError('a historical snapshot needs an event boundary');
  const states = new Map(), latest = new Map();
  for (const event of events) {
    if (event.event_id > throughEvent) break;
    const detail = typeof event.event_detail === 'string' ? JSON.parse(event.event_detail) : event.event_detail ?? {};
    if (event.event_kind === 'test-quarantine') {
      latest.set(key(detail), { file: detail.file, name: detail.name, item: event.item_id, eventId: event.event_id,
        nativeCore: detail.engine >= quarantineCoreEngine, autoSubmit: detail.engine >= autoSubmitEngine && detail.autoSubmit === true });
    }
    if (event.item_id == null) continue;
    const state = states.get(event.item_id) ?? { verified: false, withdrawn: false, merged: false };
    if (event.event_kind === 'accept') { state.verified = true; state.withdrawn = false; }
    if (['reject', 'reopen', 'claim'].includes(event.event_kind)) { state.verified = false; state.withdrawn = false; }
    if (event.event_kind === 'submit') { state.verified = Boolean(detail.mergeOnly); state.withdrawn = false; }
    if (event.event_kind === 'withdraw') { state.verified = false; state.withdrawn = true; }
    if (event.event_kind === 'merged') state.merged = true;
    states.set(event.item_id, state);
  }
  return [...latest.values()].map(entry => {
    const state = states.get(entry.item) ?? { verified: false, withdrawn: false, merged: false };
    let streak = 0;
    const seen = new Set();
    if (entry.nativeCore && !entry.autoSubmit) for (const run of runs) {
      if (run.eventId <= entry.eventId || run.eventId > throughEvent || seen.has(run.id)
        || ['suite', 'main-red'].includes(run.kind) || !Array.isArray(run.testOutcomes)
        || !(run.version === 1 || run.version === 2 && run.proof?.sourceClean === true && [0, 1].includes(run.proof?.exitCode))) continue;
      seen.add(run.id);
      const outcome = run.testOutcomes.find(row => row.file === entry.file && row.name === entry.name);
      if (!outcome || outcome.skipped) continue;
      streak = outcome.passed ? streak + 1 : 0;
      if (streak === 20) break;
    }
    const lifted = entry.autoSubmit ? state.merged : state.verified || !entry.nativeCore && state.withdrawn || streak === 20;
    return { ...entry, status: lifted ? 'lifted' : 'quarantined' };
  });
}
