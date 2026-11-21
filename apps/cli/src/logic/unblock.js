/** Unblock planner: builder capacity against buildable items, stuck items traced to root blockers, roots ranked [C7,B8]. */

const HOLD_CAUSES = ['parent', 'person', 'coordinator', 're-bar', 'other'];

/** Pure plan from one milestone's rows: items {id,status,route,routes,rescoped,after,parent,gateAtHead,folder}, holds {item,kind}, claims {item,dead}, seats {route,live,builder}, gates {item,deferred,settled}. */
export function unblockPlan(rows) {
  const items = rows.items ?? [];
  const byId = new Map(items.map(item => [item.id, item]));
  const holds = new Map((rows.holds ?? []).map(hold => [hold.item, hold.kind]));
  const claims = new Map((rows.claims ?? []).map(claim => [claim.item, claim]));
  const gates = new Map((rows.gates ?? []).map(gate => [gate.item, gate]));
  const landed = id => byId.get(id)?.status === 'landed';
  const unfinished = item => (item.after ?? []).filter(id => !landed(id));
  const openChildren = id => items.filter(item => item.parent === id && item.status !== 'landed');
  const isHeldParent = item => holds.get(item.id) === 'parent' && openChildren(item.id).length > 0;
  const waiting = item => item.status === 'open' && (holds.has(item.id) || unfinished(item).length > 0);

  const capacity = {};
  for (const seat of rows.seats ?? []) if (seat.live && seat.builder !== false) capacity[seat.route] = (capacity[seat.route] ?? 0) + 1;
  const buildable = {};
  for (const item of items) {
    if (item.status !== 'open' || holds.has(item.id) || unfinished(item).length || item.gateAtHead) continue;
    for (const route of item.routes ?? [item.route]) if (!(item.rescoped ?? []).includes(route)) buildable[route] = (buildable[route] ?? 0) + 1;
  }

  // Walk an item to the unfinished items that stop it: a waiting dependency is walked through, a held parent with open children resolves to them.
  const memo = new Map();
  const rootsOf = (id, trail = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const item = byId.get(id);
    if (!item || trail.has(id)) return new Set();
    const next = new Set(trail).add(id);
    const roots = new Set();
    if (isHeldParent(item)) for (const child of openChildren(id)) for (const root of rootsOf(child.id, next)) roots.add(root);
    else if (!waiting(item) || (!unfinished(item).length && holds.has(id))) roots.add(id);
    else for (const dep of unfinished(item)) for (const root of rootsOf(dep, next)) roots.add(root);
    memo.set(id, roots);
    return roots;
  };

  const stuck = items.filter(waiting);
  const dependents = new Map();
  for (const item of stuck) for (const root of rootsOf(item.id)) if (root !== item.id) dependents.set(root, [...(dependents.get(root) ?? []), item.id]);
  for (const item of stuck) if (rootsOf(item.id).has(item.id)) dependents.set(item.id, [...(dependents.get(item.id) ?? []), item.id]);

  const causeOf = id => {
    const item = byId.get(id);
    const claim = claims.get(id);
    const gate = gates.get(id);
    if (claim?.dead) return 'dead-claim';
    if (item.folder) return 'folder';
    if (item.rescoped?.length) return 're-scope';
    if (holds.has(id)) return HOLD_CAUSES.includes(holds.get(id)) ? `hold-${holds.get(id)}` : 'hold-other';
    if (gate?.deferred && !gate.settled) return 'unsettled-gate';
    return item.status === 'open' ? 'free-open' : 'building';
  };
  const commandFor = (id, cause, deps) => {
    if (cause === 'dead-claim' || cause === 'folder') return `pullboard release ${id} --reason OTHER --note "dead claim or folder"; or keep it: pullboard claim ${id}`;
    if (cause === 'unsettled-gate' || cause === 'free-open') return `pullboard claim ${id}`;
    if (cause === 're-scope') return `pullboard refreeze ${id}`;
    if (cause === 'hold-parent') {
      const children = openChildren(id).map(child => child.id).join(' ');
      return children ? `pullboard edit ${deps[0]} --after ${children}` : `pullboard hold ${id} --off`;
    }
    if (cause.startsWith('hold-')) return `pullboard hold ${id} --off`;
    return `pullboard show ${id}`;
  };

  const roots = [...dependents].map(([id, deps]) => {
    const cause = causeOf(id);
    return { id, cause, weight: deps.length, dependents: deps.sort((a, b) => a - b), command: commandFor(id, cause, deps) };
  }).sort((a, b) => b.weight - a.weight || a.id - b.id);
  const causes = {};
  for (const root of roots) {
    causes[root.cause] ??= { roots: [], items: 0 };
    causes[root.cause].roots.push(root.id);
    causes[root.cause].items += root.weight;
  }
  return { capacity, buildable, stuck: stuck.length, roots, causes };
}
