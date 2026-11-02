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
    || previous.eventId > eventId || !Array.isArray(previous.quarantines))) throw new TypeError('invalid previous flake ratchet snapshot');
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
  const snapshot = { version: 1, eventId, quarantines: active.map(({ file, name, item }) => ({ file, name, item })) };
  return { snapshot, unprotected, malformed: malformed.map(({ file, name }) => ({ file, name })), unjustified: increases,
    allowed: !unprotected.length && !malformed.length && !increases.length };
}
