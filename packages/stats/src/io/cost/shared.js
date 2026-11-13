/** Ordered shared-session counters without raw native identifiers or invented item splits [N2]. */
import { COST_ENGINE } from '../../../../state/light.js';
import { sanitizedUsage } from '../cost.js';
import { sumUsage } from './usage.js';
import { ENGINE_VERSION } from '../../../../state/light.js';
import { Refused } from '../../../../kernel/light.js';

/** Read only sanitized public aliases and numeric counters, never private native session data. */
export function sharedSessionTotals(board) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'shared-cost:%'").all().map((row) => JSON.parse(row.meta_value));
}

/** Let an overlap participant publish its cumulative native delta once across all participating seats. */
export function recordSharedUsage(board, { agentId, id, seats, allocations, revision, observedAt, records }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < COST_ENGINE) throw new Refused('ENGINE_VERSION', `shared usage requires engine ${COST_ENGINE}`);
  const registered = board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? LIMIT 1');
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id) || !Array.isArray(seats) || seats.length < 2 || seats.length > 100 || !seats.includes(agentId) || seats.some((seat) => !registered.get(seat)) || new Set(seats).size !== seats.length || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(observedAt) || observedAt < 0) throw new Refused('USAGE_RECORD', 'shared usage needs a public alias, registered participant seats, numeric checkpoint and positive revision');
  if (!Array.isArray(allocations) || allocations.length < 2 || allocations.length > 100 || allocations.some((value) => !value || Object.keys(value).some((key) => !['seat', 'item'].includes(key)) || !seats.includes(value.seat) || !Number.isSafeInteger(value.item)) || seats.some((seat) => !allocations.some((value) => value.seat === seat))) throw new Refused('USAGE_RECORD', 'shared usage names its registered seat/item allocations');
  for (const allocation of allocations) {
    board.nativePorts.getItem(board, allocation.item);
    if (!board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' LIMIT 1").get(allocation.item, allocation.seat)) throw new Refused('USAGE_RECORD', 'shared allocations name only items their seats claimed');
  }
  const value = { id, allocations: allocations.map((row) => ({ seat: row.seat, item: row.item })), seats: [...seats], revision, observedAt, records: sanitizedUsage(records, board.executionEngineVersion ?? ENGINE_VERSION) };
  return board.nativePorts.atomic(board, () => {
    const key = `shared-cost:${id}`;
    const old = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    const previous = old && JSON.parse(old.meta_value);
    if (previous && (previous.seats.some((seat) => !seats.includes(seat)) || previous.allocations.some((old) => !allocations.some((row) => row.seat === old.seat && row.item === old.item)))) throw new Refused('USAGE_RECORD', 'retain every previously recorded participant when extending a shared usage record');
    if (previous?.revision >= revision) {
      if (previous.revision === revision && JSON.stringify(previous) !== JSON.stringify(value)) throw new Refused('USAGE_CHANGED', 'this shared usage revision already binds different counters');
      return { duplicate: true };
    }
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, JSON.stringify(value));
    for (const item of new Set(allocations.map((row) => row.item))) {
      const markerKey = `shared-item:${item}`;
      const marker = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(markerKey);
      const groups = marker ? JSON.parse(marker.meta_value).groups : [];
      if (!groups.includes(id)) groups.push(id);
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(markerKey, JSON.stringify({ groups, latest: { id, revision } }));
    }
    board.nativePorts.logEvent(board, agentId, 'shared-usage', null, { ...value, estimate: true });
    return { recorded: true };
  });
}

/** Shared-session models remain available separately from unmeasurable per-item splits. */
export function publicSharedSessions(board) {
  return sharedSessionTotals(board).map((value) => ({ ...value, ...sumUsage(value.records) }));
}
