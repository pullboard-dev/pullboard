/** Quarantine changes blocking authority, never the observed process result [C7,H16]. */

/** A portable source identity cannot name a different file through path normalization. */
function identity(value) {
  return value && typeof value.file === 'string' && value.file.length > 0 && value.file.length <= 4096
    && !value.file.startsWith('/') && !/^[A-Za-z]:/u.test(value.file) && !/[\\\r\n\0]/u.test(value.file)
    && value.file.split('/').every(part => part && part !== '.' && part !== '..')
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 8192 && !/[\r\n\0]/u.test(value.name);
}

/** File and case name jointly identify a test; a repeated title in another file is never covered. */
function key(value) { return JSON.stringify([value.file, value.name]); }

/** Normalize only exact event-bound exceptions to a raw exit-one failure account. */
export function quarantineVerdictFields(value, { green, exitCode, failures } = {}) {
  if (!value || Object.keys(value).sort().join(',') !== 'exitCode,green,quarantines,version'
    || value.version !== 1 || value.exitCode !== 1 || exitCode !== 1 || green !== false
    || typeof value.green !== 'boolean' || !Array.isArray(failures) || !failures.length || failures.length > 500
    || failures.some(row => !identity(row)) || new Set(failures.map(key)).size !== failures.length
    || !Array.isArray(value.quarantines) || !value.quarantines.length || value.quarantines.length > failures.length) return null;
  const failed = new Set(failures.map(key)), covered = new Set(), events = new Set(), quarantines = [];
  for (const row of value.quarantines) {
    if (!row || Object.keys(row).sort().join(',') !== 'eventId,file,item,name' || !identity(row)
      || !Number.isSafeInteger(row.eventId) || row.eventId < 1 || !Number.isSafeInteger(row.item) || row.item < 1
      || !failed.has(key(row)) || covered.has(key(row)) || events.has(row.eventId)) return null;
    covered.add(key(row)); events.add(row.eventId);
    quarantines.push({ eventId: row.eventId, item: row.item, file: row.file, name: row.name });
  }
  if (value.green !== failures.every(row => covered.has(key(row)))) return null;
  quarantines.sort((a, b) => key(a).localeCompare(key(b)));
  return { version: 1, exitCode: 1, green: value.green, quarantines };
}

/** Derive a verdict only after the caller has completely accounted for the actual failed process. */
export function quarantineVerdict(failures, quarantines, { green, exitCode } = {}) {
  if (!Array.isArray(failures) || !Array.isArray(quarantines)) return null;
  const held = new Map(quarantines.map(row => [key(row), row]));
  const covered = failures.flatMap(row => {
    const entry = held.get(key(row));
    return entry ? [{ eventId: entry.eventId, item: entry.item, file: row.file, name: row.name }] : [];
  });
  return quarantineVerdictFields({ version: 1, exitCode, green: covered.length === failures.length, quarantines: covered },
    { green, exitCode, failures });
}

/** A receipt without the new field keeps its exact old raw verdict. */
export function receiptBlockingGreen(receipt) {
  if (!receipt || typeof receipt.green !== 'boolean') return false;
  if (!Object.hasOwn(receipt, 'blockingVerdict')) return receipt.green && (receipt.version !== 2 || receipt.proof?.exitCode === 0);
  return quarantineVerdictFields(receipt.blockingVerdict, { green: receipt.green,
    exitCode: receipt.version === 2 ? receipt.proof?.exitCode : receipt.blockingVerdict?.exitCode, failures: receipt.failures })?.green === true;
}

/** Native board proof rows retain raw counts and exit while exposing the same explicit blocking decision. */
export function nativeProofBlockingGreen(receipt) {
  if (!receipt) return false;
  if (!Object.hasOwn(receipt, 'blockingVerdict')) return receipt.exitCode === 0;
  return quarantineVerdictFields(receipt.blockingVerdict, { green: receipt.exitCode === 0,
    exitCode: receipt.exitCode, failures: receipt.failures })?.green === true;
}

/** Every serialized landing cache location has the same quarantine authority contract. */
export function landingGateRecords(batch) {
  return [...(batch?.gateResults ?? []), ...(batch?.deferredGateResults ?? []), ...(batch?.parallelCandidates ?? []).flatMap(candidate =>
    [...(candidate.snapshot?.gateResults ?? []), ...(candidate.snapshot?.deferredGateResults ?? []), ...(candidate.gate ? [candidate.gate] : [])])];
}

/** Presence, including malformed values, requires a receiver that understands the new evidence. */
export function quarantineBatchGates(batch) {
  return landingGateRecords(batch).filter(gate => Object.hasOwn(gate ?? {}, 'blockingVerdict'));
}


/** Remove covered identities only from an already authenticated complete raw account; callers validate board authority. */
export function blockingFailures(run, failures) {
  if (!Object.hasOwn(run ?? {}, 'blockingVerdict')) return failures;
  const raw = run.quarantineFailures ?? run.failures ?? failures;
  const verdict = quarantineVerdictFields(run.blockingVerdict, { green: run.rawIsGreen ?? run.green ?? false,
    exitCode: run.exitCode ?? run.proof?.exitCode ?? run.blockingVerdict?.exitCode, failures: raw });
  if (!verdict) return null;
  const rows = Array.isArray(failures) ? failures.filter(row => raw.some(entry => key(entry) === key(row))) : raw;
  if (rows.length !== raw.length || raw.some(entry => !rows.some(row => key(entry) === key(row)))) return null;
  const covered = new Set(verdict.quarantines.map(key));
  return rows.filter(row => !covered.has(key(row)));
}
