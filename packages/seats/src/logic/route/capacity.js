/** Compare live idle seats with compatible free work without counting a seat at multiple routes [A6,N2,B13]. */
import { ROUTES } from './escalation.js';
import { canTake } from './escalation.js';
import { takeoverReady } from '../line/capacity.js';

/**
 * Use the queue's held/dependency/collision-filtered entries and health's existing idle projection.
 * A reserved return is free only to its original builder until the canonical takeover rule permits
 * others. Read that boundary once per item, rather than once for every possible seat/item pair.
 * The caller supplies the store's first-refusal reader, so seat capacity never loads board reads.
 */
export function routeWorkShortages(board, entries, agents, { firstRefusal }) {
  const restrictions = new Map();
  /** Retain exactly the same builder reservation and configured takeover condition as next. */
  function reservedFor(id) {
    if (!restrictions.has(id)) {
      const window = firstRefusal(board, id);
      restrictions.set(id, window && !takeoverReady(board, id) ? window.builder : null);
    }
    return restrictions.get(id);
  }
  return ROUTES.flatMap(route => {
    const idle = agents.filter(agent => agent.idle && agent.route === route);
    if (!idle.length) return [];
    const ids = new Set(idle.map(agent => agent.id));
    const free = new Set(entries.filter(entry => canTake(route, entry.route)
      && (reservedFor(entry.id) === null || ids.has(reservedFor(entry.id)))).map(entry => entry.id)).size;
    if (free >= idle.length) return [];
    const since = idle.reduce((earliest, agent) => agent.idleSince < earliest ? agent.idleSince : earliest, idle[0].idleSince);
    return [{ route, free, idle: idle.length, since }];
  });
}
