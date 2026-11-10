/** Private native-session overlap accounting; public aliases are unrelated to native identities [N2]. */
import { randomUUID } from 'node:crypto';
import { sessionSnapshot } from '../session.js';

/** Count one native delta while its previously established overlap is active. */
export function sharedBefore(state, session, now, advance, changed) {
  state.sharedTotals ??= {};
  state.sharedActive ??= {};
  const group = session && state.sharedActive[session];
  if (group) advance(state, group, now, changed);
}

/** Open or close an overlap at the actual attribution boundary, never divide its native counters. */
export function sharedAfter(state, session, now, advance, changed) {
  if (!session) return;
  const active = state.active.filter((entry) => entry.session === session);
  const group = state.sharedActive[session];
  if (active.length < 2) {
    if (group) {
      // Remaining seats must consume the shared interval as unknown before resuming solo deltas.
      for (const entry of active) advance(state, entry, now, changed);
      delete state.sharedActive[session];
    }
    return;
  }
  if (group) {
    group.seats = [...new Set([...group.seats, ...active.map((entry) => entry.agent)])];
    for (const entry of active) if (!group.allocations.some((value) => value.seat === entry.agent && value.item === entry.item)) group.allocations.push({ seat: entry.agent, item: entry.item });
    advance(state, group, now, changed);
    return;
  }
  const source = active[0].source;
  const snapshot = sessionSnapshot(source, undefined, now, state.cursors);
  const entry = { sharedId: randomUUID(), allocations: active.map((value) => ({ seat: value.agent, item: value.item })), seats: [...new Set(active.map((value) => value.agent))], session,
    source, snapshot, model: snapshot?.model ?? active[0].model, at: now };
  state.sharedActive[session] = entry;
  advance(state, entry, now, changed);
}
