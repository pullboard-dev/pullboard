import { MILESTONE_QUEUE_ORDER_ENGINE } from '../../../state/light.js';
import { COORDINATOR_ACTIONS_ENGINE } from '../../../state/index.js';
import { MILESTONE_LIMIT_ENGINE } from "../../../state/light.js";
import { MILESTONE_PERSON_LIMIT_ENGINE } from "../../../state/index.js";
import { MILESTONE_SHIP_ENGINE } from "../../../state/light.js";
import { MILESTONE_MODE_ENGINE } from "../../../state/light.js";
import { MILESTONE_BUMP_ENGINE } from "../../../state/light.js";
/**
 * The roadmap's milestones: ordered names, notes, targets and item references kept in one
 * board_meta value, with automatic placement and reasoned coordinator or person overrides (N26,B35).
 *
 * An item counts toward a milestone only once it has landed on main: it is verified and its merge
 * commit is recorded. Shipping a milestone records main's commit and carries every unlanded item
 * into the next milestone, so the roadmap stays the one place that says what is planned.
 */
import { COORDINATOR } from "../../../config/index.js";
import {
  ENGINE_VERSION,
  MILESTONE_RANK_ENGINE,
  WITHDRAW_MILESTONE_ENGINE,
} from "../../../state/index.js";
import { Refused } from "../../../kernel/light.js";
import { isLanded } from "./progress.js";
import { WORK_ORDER_ENGINE } from "../../../state/light.js";
import { MILESTONE_PLACEMENT_ENGINE } from "../../../state/light.js";
import { LIVE_RELEASE_PLACEMENT_ENGINE } from "../../../state/light.js";
import { placementFor } from "./placement.js";
import { placementNote } from "./placement.js";

/** Require real store operations before a roadmap operation can read or mutate its board. */
function milestonePorts(ports, names) {
  if (!names.every(name => name === 'PERSON' ? typeof ports?.PERSON === 'string' : typeof ports?.[name] === 'function')) throw new TypeError('milestone operation needs explicit store ports');
  return ports;
}

/** The engine a move runs under: its recorded one during replay, else this client's. */
function engineOf(board) {
  return board.executionEngineVersion ?? ENGINE_VERSION;
}

/**
 * An item's roadmap state: landed once its merge onto main is recorded, accepted while verified
 * but not yet landed, and otherwise its board status.
 *
 * @param {string} status
 * @param {boolean} landed
 * @returns {string}
 */
export function roadmapState(status, landed) {
  // A hand landing closes the item as withdrawn but records a merge commit: it landed, so it keeps its place and count [#8470].
  if ((status === 'verified' || status === 'withdrawn') && landed) return 'landed';
  return status === 'verified' ? 'accepted' : status;
}

/** Order work for shipping: unfinished items first, then verified items, preserving each group. */
export function shippingOrder(entries) {
  const kept = entries.filter((item) => item.status !== 'withdrawn' || item.state === 'landed');
  const verified = kept.filter((item) => item.status === 'verified');
  return [...kept.filter((item) => item.status !== 'verified'), ...verified];
}

/** Return local milestones that list an item, in stored roadmap order including shipped milestones. */
export function milestonesListing(board, id, ports) {
  const { milestones } = milestonePorts(ports, ["milestones"]);
  return milestones(board).filter((milestone) => milestone.items.includes(id)).map((milestone) => milestone.name);
}

/** Return each milestone and its matching references, preserving milestone and item order. */
export function milestoneReferencesToRemove(board, references, ports) {
  const { milestones } = milestonePorts(ports, ["milestones"]);
  const wanted = new Set(references);
  return milestones(board).flatMap((milestone) => {
    const remove = milestone.items.filter((reference) => wanted.has(reference));
    return remove.length ? [{ name: milestone.name, remove }] : [];
  });
}

/**
 * Return milestones with each item's current status and state, a landed count, and the
 * milestone's target and shipment. `done` is the landed count: accepted work has not shipped yet.
 *
 * @param {any} board
 * @param {((reference: string) => any) | null} [resolveExternal]
 * @returns {any[]}
 */
export function roadmap(board, resolveExternal = null, ports) {
  const { listItems, milestones } = milestonePorts(ports, ["listItems", "milestones"]);
  const onMain = typeof ports.onMain === 'function' ? ports.onMain : null;
  const items = new Map(listItems(board, { all: true }).map((item) => [item.item_id, item]));
  const at = board.clock.now().getTime();
  return milestones(board).map((milestone) => {
    const named = milestone.items.map((id) => {
      if (typeof id === 'number') {
        const item = items.get(id);
        return item
          ? { id, title: item.item_title, status: item.item_status, state: roadmapState(item.item_status, isLanded(item, onMain)) }
          : { id, title: `#${id}`, status: 'missing', state: 'missing' };
      }
      const external = resolveExternal?.(id) ?? { id, title: id, status: 'unavailable' };
      return { id: external.id, title: external.title, status: external.status, state: roadmapState(external.status, Boolean(external.landed)) };
    });
    const entries = shippingOrder(named);
    const landed = entries.filter((item) => item.state === 'landed').length;
    const target = milestone.target ?? null;
    return {
      name: milestone.name,
      note: milestone.note,
      target,
      pastTarget: !milestone.shipped && target !== null && Date.parse(target) <= at,
      shipped: milestone.shipped ?? null,
      count: milestone.items.length,
      limit: milestone.limit ?? null,
      mode: milestone.mode ?? 'rollover',
      items: entries,
      landed,
      done: landed,
      total: entries.length,
      withdrawn: named.length - entries.length,
    };
  });
}

/** Validate a coordinator identity before changing roadmap metadata. */
function requireCoordinator(agentId) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator changes milestones; ask your coordinator to update the roadmap');
}

/** Parse an ordered list of local item ids and repo-qualified ids. */
function normalizeMilestoneItems(items) {
  if (!Array.isArray(items)) throw new Refused('MILESTONE_ITEMS', 'milestone items need comma-separated item ids; use pullboard milestone add --items 1,2');
  const result = items.map((value) => {
    if (Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
      if (/^[^#,\s][^#,]*#[1-9]\d*$/.test(text)) return text;
    }
    throw new Refused('MILESTONE_ITEMS', `invalid item id ${String(value)}; use a positive id or repo#id`);
  });
  if (new Set(result.map((value) => JSON.stringify(value))).size !== result.length) {
    throw new Refused('MILESTONE_ITEMS', 'a milestone cannot list the same item twice; remove duplicate ids and retry');
  }
  return result;
}

/** Refuse local item ids that do not exist while leaving repo-qualified ids for board lookup. */
function validateLocalMilestoneItems(board, items, itemById) {
  for (const id of items) if (typeof id === 'number') itemById(board, id);
}

/** Permit the coordinator, or a person explicitly giving the reason for an override [B35,H16]. */
function placementActor(board, agentId, person, reason) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (engineOf(board) >= MILESTONE_PLACEMENT_ENGINE && agentId === person) {
    if (!why) throw new Refused('MILESTONE_PLACED', 'the board places items; a person override needs --reason "<why>"');
    return why;
  }
  requireCoordinator(agentId);
  return why;
}

/** Remove an overridden automatic assignment from other open releases, retaining shipment history and surviving ranks. */
function movePlacedItems(entries, target, placed) {
  for (let other = 0; other < entries.length; other++) {
    if (other === target || entries[other].shipped) continue;
    const previous = entries[other];
    const remaining = previous.items.filter(id => !placed.includes(id));
    if (remaining.length === previous.items.length) continue;
    entries[other] = { ...previous, items: remaining, ...(previous.order ? { order: previous.order.filter(id => remaining.includes(id)) } : {}) };
    if (previous.sunk || previous.reasons) entries[other] = withOverrides(entries[other], entries[other].order ?? [], (previous.sunk ?? []).filter(id => remaining.includes(id)));
  }
}

/** Validate a milestone name and note before storing them. */
function normalizeMilestoneText(name, note = null) {
  if (typeof name !== 'string' || !name.trim()) throw new Refused('MILESTONE_NAME', 'a milestone needs a name; use pullboard milestone add <name>');
  if (typeof note !== 'string' && note !== null) throw new Refused('MILESTONE_NOTE', 'a milestone note needs text; use --note <text>');
  return { name: name.trim(), note: note?.trim() || null };
}


/**
 * A target as ISO text, or null for `none`, which clears it. Applying a move accepts only a date or
 * a date and time with an explicit zone, so every replica reads the same instant: a bare local
 * time would mean a different moment on a machine in another zone.
 *
 * @param {unknown} target
 * @returns {string | null}
 */
function normalizeMilestoneTarget(target) {
  if (target === 'none') return null;
  const text = typeof target === 'string' ? target.trim() : '';
  const zoned = /^\d{4}-\d{2}-\d{2}$/.test(text) || /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const at = zoned ? Date.parse(text) : NaN;
  if (!Number.isFinite(at)) throw new Refused('MILESTONE_TARGET', 'a target needs a date, or a date and time with its zone, like 2026-10-20T18:00Z; use --target <date and time>, or --target none to clear it');
  return new Date(at).toISOString();
}

/** Save the whole milestone list in one board_meta value. */
function saveMilestones(board, entries) {
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run('milestones', JSON.stringify(entries));
}

/** The refusal for adding work to a milestone that already shipped. */
function shippedRefusal(entry) {
  return new Refused('MILESTONE_SHIPPED', `milestone ${entry.name} shipped at ${entry.shipped.commit}; add the item to the next milestone instead`);
}

/** Add an ordered milestone without changing any referenced board items. */
export function addMilestone(board, { agentId, name, note = null, items = [], reason }, ports) {
  const { atomic, itemById, logEvent, milestones, PERSON } = milestonePorts(ports, ["atomic", "itemById", "logEvent", "milestones", "PERSON"]);
  const why = placementActor(board, agentId, PERSON, reason);
  const text = normalizeMilestoneText(name, note);
  const normalized = normalizeMilestoneItems(items);
  validateLocalMilestoneItems(board, normalized, itemById);
  const placed = placedItems(board, normalized);
  if (placed.length && !why) throw new Refused('MILESTONE_PLACED', 'the board places items; creating a release with new work needs an override --reason "<why>"');
  return atomic(board, () => {
    const entries = milestones(board);
    if (entries.some((entry) => entry.name === text.name)) throw new Refused('MILESTONE_EXISTS', `milestone ${text.name} already exists; edit it or choose another name`);
    entries.push({ ...text, items: normalized });
    movePlacedItems(entries, entries.length - 1, placed);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_add', null, { name: text.name, items: normalized, ...(why ? { reason: why } : {}) });
    for (const id of placed) logEvent(board, agentId, 'milestone_placed', id, { milestone: text.name, rule: 'override', reason: why, note: `placed in ${text.name} by override: ${why}` });
    return text.name;
  });
}

/** Validate an optional item cap; null explicitly turns the cap off [N26]. */
function normalizeMilestoneLimit(limit) {
  if (limit === null || limit === 'none') return null;
  const value = typeof limit === 'string' && /^(?:0|[1-9]\d*)$/u.test(limit) ? Number(limit) : limit;
  if (!Number.isSafeInteger(value) || value < 0) throw new Refused('MILESTONE_LIMIT', 'set --limit to a nonnegative integer, or none to turn it off');
  return value;
}

/** Enforce the receiver's cap on new moves, leaving older recorded moves unchanged [H16,N26]. */
function enforceMilestoneLimit(board, milestone, items, itemById, plainAdd = false) {
  if (engineOf(board) < MILESTONE_LIMIT_ENGINE || milestone.limit == null || items.length <= milestone.limit) return;
  const unstarted = milestone.items.filter(id => typeof id === 'number' && itemById(board, id)?.item_status === 'open');
  const candidates = unstarted.length ? unstarted.map(id => `#${id}`).join(', ') : 'none';
  if (plainAdd && engineOf(board) >= MILESTONE_PERSON_LIMIT_ENGINE) {
    throw new Refused('MILESTONE_LIMIT', `${milestone.name} would have ${items.length} items, above limit ${milestone.limit}; an agent or the coordinator cannot grow it; unstarted items that could move out: ${candidates}; swap one out with --add <id> --swap <id>, or ask the person to raise it: pullboard milestone edit ${JSON.stringify(milestone.name)} --limit <n>|none --as person in the main checkout`);
  }
  throw new Refused('MILESTONE_LIMIT', `${milestone.name} would have ${items.length} items, above limit ${milestone.limit}; unstarted items that could move out: ${candidates}; use pullboard milestone items ${JSON.stringify(milestone.name)} --add <id> --swap <id>, remove items, or raise --limit`);
}

/**
 * A rollover release past its limit passes its lowest unstarted item (the last open one in its order) to the next unshipped release
 * with room, keeping the add; null leaves the refusal as it was: an earlier engine, explicit mode, nothing unstarted or no room [N26].
 */
function bumpForRollover(board, entries, index, nextItems, itemById) {
  const current = entries[index];
  if (engineOf(board) < MILESTONE_BUMP_ENGINE || (current.mode ?? 'rollover') !== 'rollover' || current.limit == null || nextItems.length <= current.limit) return null;
  const ranked = [...(current.order ?? []), ...current.items.filter(id => !(current.order ?? []).includes(id))];
  const id = ranked.filter(member => current.items.includes(member) && typeof member === 'number' && itemById(board, member)?.item_status === 'open').pop();
  if (id === undefined) return null;
  const into = entries.findIndex((entry, at) => at > index && !entry.shipped);
  if (into < 0 || (entries[into].limit != null && entries[into].items.length >= entries[into].limit)) return null;
  return { id, into };
}

/**
 * Edit membership atomically. A swap removes and adds in one receiver transaction, checked against
 * the final count; historical add/remove moves retain their recorded meaning [N26,H16].
 */
export function editMilestoneItems(board, name, { agentId, add = [], remove = [], swap = [], reason, asPerson = false }, ports) {
  const { atomic, itemById, logEvent, milestones, PERSON } = milestonePorts(ports, ["atomic", "itemById", "logEvent", "milestones", "PERSON"]);
  const why = placementActor(board, agentId, PERSON, reason);
  const additions = normalizeMilestoneItems(add);
  const removals = normalizeMilestoneItems(remove);
  const swaps = normalizeMilestoneItems(swap);
  if (swaps.length && engineOf(board) < MILESTONE_LIMIT_ENGINE) throw new Refused('ENGINE_VERSION', `milestone swap requires engine ${MILESTONE_LIMIT_ENGINE}; upgrade Pullboard before using --swap`);
  validateLocalMilestoneItems(board, additions, itemById);
  if (additions.length && removals.length) throw new Refused('MILESTONE_ITEMS', 'add or remove milestone items in separate commands');
  if (swaps.length && (!additions.length || removals.length || swaps.length !== 1 || additions.length !== 1)) throw new Refused('MILESTONE_ITEMS', 'swap one item out with --add <id> --swap <id>; use --remove separately');
  if (!additions.length && !removals.length) throw new Refused('MILESTONE_ITEMS', 'name ids with --add or --remove');
  const placed = placedItems(board, additions);
  if (placed.length && !why) throw new Refused('MILESTONE_PLACED', `the board places items: ${placed.map(id => `#${id}`).join(', ')} ${placed.length === 1 ? 'was' : 'were'} placed by rule; override with --reason "<why>"`);
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const current = entries[index];
    if (additions.length && current.shipped) throw shippedRefusal(current);
    const removed = [...removals, ...swaps];
    if (removed.some(id => !current.items.includes(id))) throw new Refused('MILESTONE_ITEMS', 'one or more ids are not in this milestone; read pullboard roadmap and retry');
    if (additions.some(id => current.items.includes(id))) throw new Refused('MILESTONE_ITEMS', 'a milestone cannot list the same item twice; remove duplicate ids and retry');
    let nextItems = swaps.length
      ? current.items.map(id => id === swaps[0] ? additions[0] : id)
      : [...current.items.filter(id => !removed.includes(id)), ...additions];
    // The person's signed add may grow a milestone past its limit; an agent or the coordinator may not [N26,H16].
    const personGrows = asPerson && swaps.length === 0 && engineOf(board) >= MILESTONE_PERSON_LIMIT_ENGINE;
    const bump = additions.length && !personGrows && swaps.length === 0 ? bumpForRollover(board, entries, index, nextItems, itemById) : null;
    if (additions.length && !personGrows && !bump) enforceMilestoneLimit(board, current, nextItems, itemById, swaps.length === 0);
    if (bump) {
      nextItems = nextItems.filter(id => id !== bump.id);
      const target = entries[bump.into];
      entries[bump.into] = { ...target, items: [bump.id, ...target.items], ...(target.order ? { order: [bump.id, ...target.order] } : {}) };
    }
    entries[index] = { ...current, items: nextItems,
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= MILESTONE_RANK_ENGINE && current.order
        ? { order: current.order.map(id => swaps.includes(id) ? additions[0] : id).filter(id => nextItems.includes(id)) } : {}) };
    if (engineOf(board) >= WORK_ORDER_ENGINE && (current.sunk || current.reasons)) {
      entries[index] = withOverrides(entries[index], entries[index].order ?? [], (current.sunk ?? []).filter(id => nextItems.includes(id)));
    }
    movePlacedItems(entries, index, placed);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_items', null, { name, add: additions, remove: removals, ...(swaps.length ? { swap: swaps } : {}), ...(why ? { reason: why } : {}), ...(personGrows ? { asPerson: true } : {}) });
    for (const id of placed) logEvent(board, agentId, 'milestone_placed', id, { milestone: name, rule: 'override', reason: why, note: `placed in ${name} by override: ${why}` });
    if (bump) logEvent(board, agentId, 'milestone_moved', bump.id, { from: name, to: entries[bump.into].name, note: `bumped from ${name} to ${entries[bump.into].name}: ${name} was full and rolls its lowest unstarted item over` });
    return nextItems;
  });
}

/** Local items the board placed by rule, which a plain manual add may not move. */
function placedItems(board, additions) {
  if (engineOf(board) < MILESTONE_PLACEMENT_ENGINE) return [];
  const placed = board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'milestone_placed' LIMIT 1");
  return additions.filter(id => typeof id === 'number' && placed.get(id));
}

/**
 * Place a new item by the board's rule inside its add transaction and record the rule and its inputs on the item
 * [N26,B35]. A milestone at its --limit passes the item on to the next unshipped milestone with room.
 */
export function placeNewItem(board, id, item, ports) {
  const { itemById, logEvent, milestones } = milestonePorts(ports, ["itemById", "logEvent", "milestones"]);
  if (engineOf(board) < MILESTONE_PLACEMENT_ENGINE) return null;
  const entries = milestones(board);
  /** The row for a local id, or null when it is not on this board. */
  const itemOf = ref => { try { return ref === null ? null : itemById(board, ref) ?? null; } catch { return null; } };
  let placed = placementFor(entries, item, itemOf, { liveReleases: engineOf(board) >= LIVE_RELEASE_PLACEMENT_ENGINE });
  if (placed.index >= 0) {
    const full = [];
    let index = placed.index;
    while (index < entries.length && (entries[index].shipped || (entries[index].limit != null && entries[index].items.length >= entries[index].limit))) {
      if (!entries[index].shipped) full.push(entries[index].name);
      index += 1;
    }
    placed = { ...placed, index: index < entries.length ? index : -1, milestone: entries[index]?.name ?? null, ...(full.length ? { full } : {}) };
  }
  if (placed.index >= 0) {
    const current = entries[placed.index];
    entries[placed.index] = { ...current, items: [...current.items, id], order: [...(current.order ?? []), ...current.items.filter(member => !(current.order ?? []).includes(member)), id] };
    placed.position = entries[placed.index].items.length;
    saveMilestones(board, entries);
  }
  logEvent(board, item.by, 'milestone_placed', id, { milestone: placed?.milestone ?? null, rule: placed?.rule ?? null, position: placed?.position ?? null, inputs: placed?.inputs ?? null, note: placementNote(placed) });
  return placed?.milestone ?? null;
}

/**
 * Replace this milestone's explicit ranks; omitted items retain the ordinary queue order [N2,B13]. With `place`,
 * the coordinator pins, sinks or lifts items instead (#1017).
 */
export function orderMilestoneItems(board, name, { agentId, items, place, reason }, ports) {
  const { atomic, logEvent, milestones, PERSON } = milestonePorts(ports, ["atomic", "logEvent", "milestones", "PERSON"]);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < MILESTONE_RANK_ENGINE) throw new Refused('ENGINE_VERSION', 'milestone order requires engine 34; upgrade Pullboard before ranking work');
  if (place !== undefined) return overrideMilestoneItems(board, name, { agentId, items, place, reason }, ports);
  const automatic = placedItems(board, normalizeMilestoneItems(items));
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (automatic.length && !why) throw new Refused('MILESTONE_PLACED', 'the board places items; order overrides need --reason "<why>"');
  if (automatic.length) placementActor(board, agentId, PERSON, reason);
  if (!automatic.length && agentId !== COORDINATOR && (agentId === PERSON || !board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId))) {
    throw new Refused('NO_AGENT', 'milestone order is an agent or coordinator move; join an agent worktree or ask the coordinator');
  }
  const order = normalizeMilestoneItems(items);
  if (!order.length) throw new Refused('MILESTONE_ITEMS', 'name the ranked item ids: pullboard milestone order <name> 1,2');
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex(entry => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    if (order.some(id => !entries[index].items.includes(id))) throw new Refused('MILESTONE_ITEMS', 'rank only items in this milestone; read pullboard roadmap and retry');
    const current = entries[index];
    // Explicit coordinator overrides survive ordinary order, including a coordinator's re-rank.
    const pins = engineOf(board) >= WORK_ORDER_ENGINE
      ? (current.order ?? []).filter(id => Object.hasOwn(current.reasons ?? {}, String(id))) : [];
    const sunk = engineOf(board) >= WORK_ORDER_ENGINE ? current.sunk ?? [] : [];
    const ranked = [...pins, ...order.filter(id => !pins.includes(id) && !sunk.includes(id))];
    entries[index] = { ...current, order: ranked };
    if (engineOf(board) >= WORK_ORDER_ENGINE) entries[index] = withOverrides(current, ranked, sunk);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_order', null, { name, items: order, ...(why ? { reason: why } : {}) });
    for (const id of automatic) logEvent(board, agentId, 'milestone_placed', id, { milestone: name, rule: 'override', reason: why, note: `ordered in ${name} by override: ${why}` });
    return ranked;
  });
}

/** A milestone with these pins and sinks, keeping reasons only for items still pinned or sunk. */
function withOverrides(entry, order, sunk) {
  const kept = new Set([...order, ...sunk].map(String));
  const reasons = Object.fromEntries(Object.entries(entry.reasons ?? {}).filter(([id]) => kept.has(id)));
  const { sunk: _sunk, reasons: _reasons, ...rest } = entry;
  return { ...rest, order, ...(sunk.length ? { sunk } : {}), ...(Object.keys(reasons).length ? { reasons } : {}) };
}

/**
 * The coordinator pins items above the queue's computed order, sinks them below it, or lifts either, each pin
 * and sink with its reason (#1017) [N22,B13]. An override stays through every re-rank until it is lifted.
 *
 * @param {any} board
 * @param {string} name
 * @param {{ agentId: string, items: unknown[], place: unknown, reason?: unknown }} change
 * @returns {{ order: (number | string)[], sunk: (number | string)[] }}
 */
function overrideMilestoneItems(board, name, { agentId, items, place, reason }, ports) {
  const { atomic, logEvent, milestones } = milestonePorts(ports, ["atomic", "logEvent", "milestones"]);
  if (engineOf(board) < WORK_ORDER_ENGINE) throw new Refused('ENGINE_VERSION', 'pinning and sinking queue items needs a newer engine; upgrade Pullboard before overriding the queue');
  requireCoordinator(agentId);
  if (!['pin', 'sink', 'lift'].includes(place)) throw new Refused('MILESTONE_PLACE', 'an override is pin, sink or lift: pullboard milestone pin <name> <ids> --reason "<why>"');
  const ids = normalizeMilestoneItems(items);
  if (!ids.length) throw new Refused('MILESTONE_ITEMS', `name the item ids: pullboard milestone ${place} <name> 1,2`);
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (place !== 'lift' && !text) throw new Refused('MILESTONE_REASON', `say why: pullboard milestone ${place} ${name} ${ids.join(',')} --reason "<why>"`);
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex(entry => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const current = entries[index];
    if (ids.some(id => !current.items.includes(id))) throw new Refused('MILESTONE_ITEMS', 'override only items in this milestone; read pullboard roadmap and retry');
    const retained = (current.order ?? []).filter(id => !ids.includes(id));
    const order = place === 'pin' && engineOf(board) >= MILESTONE_QUEUE_ORDER_ENGINE
      ? [...ids, ...retained] : [...retained, ...(place === 'pin' ? ids : [])];
    const sunk = [...(current.sunk ?? []).filter(id => !ids.includes(id)), ...(place === 'sink' ? ids : [])];
    const reasons = { ...Object.fromEntries(Object.entries(current.reasons ?? {}).filter(([id]) => !ids.map(String).includes(id))),
      ...(place === 'lift' ? {} : Object.fromEntries(ids.map(id => [String(id), text]))) };
    entries[index] = withOverrides({ ...current, reasons }, order, sunk);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_order', null, { name, items: ids, place, ...(text && place !== 'lift' ? { reason: text } : {}) });
    return { order, sunk };
  });
}

/** Move a milestone before another while retaining all item and note data. */
export function moveMilestone(board, name, { agentId, before }, ports) {
  const { atomic, logEvent, milestones } = milestonePorts(ports, ["atomic", "logEvent", "milestones"]);
  requireCoordinator(agentId);
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    const target = entries.findIndex((entry) => entry.name === before);
    if (index < 0 || target < 0) throw new Refused('NO_MILESTONE', `name both milestones in pullboard milestone move ${name} --before <other>`);
    if (name === before) throw new Refused('MILESTONE_ORDER', 'choose a different milestone to move before');
    const [entry] = entries.splice(index, 1);
    entries.splice(entries.findIndex((value) => value.name === before), 0, entry);
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_move', null, { name, before });
    return entries;
  });
}

/** The fill mode a milestone takes: rollover passes items on when full, explicit leaves placement to the coordinator [N26]. */
function normalizeMilestoneMode(mode) {
  if (mode === 'rollover' || mode === 'explicit') return mode;
  throw new Refused('MILESTONE_MODE', 'set --mode to rollover or explicit');
}

/** Whether a new limit lets a milestone hold more than its current one; turning a limit off counts, setting the first one does not. */
function raisesLimit(current, next) {
  if (current == null) return false;
  return next === null || next > current;
}

/**
 * Rename a milestone, update its note, or set its target without touching its items. A target is
 * an engine-45 meaning, so an older engine's edit replays exactly as it did.
 */
export function editMilestone(board, name, { agentId, newName, note, target, limit, mode, asPerson = false }, ports) {
  const { atomic, itemById, logEvent, milestones } = milestonePorts(ports, ["atomic", "itemById", "logEvent", "milestones"]);
  requireCoordinator(agentId);
  const engine = engineOf(board);
  if (limit !== undefined && engine < MILESTONE_LIMIT_ENGINE) throw new Refused('ENGINE_VERSION', `milestone limit requires engine ${MILESTONE_LIMIT_ENGINE}; upgrade Pullboard before using --limit`);
  if (mode !== undefined && engine < MILESTONE_MODE_ENGINE) throw new Refused('ENGINE_VERSION', `a milestone mode requires engine ${MILESTONE_MODE_ENGINE}; upgrade Pullboard before using --mode`);
  if (target !== undefined && engine < MILESTONE_SHIP_ENGINE) {
    throw new Refused('ENGINE_VERSION', `a milestone target requires engine ${MILESTONE_SHIP_ENGINE}; this board uses engine ${engine}; upgrade Pullboard before using --target`);
  }
  if (newName === undefined && note === undefined && target === undefined && limit === undefined && mode === undefined) {
    throw new Refused('MILESTONE_EDIT', engine < MILESTONE_SHIP_ENGINE ? 'supply --name or --note to edit a milestone' : 'supply --name, --note or --target to edit a milestone');
  }
  const limitValue = limit === undefined ? undefined : normalizeMilestoneLimit(limit);
  const modeValue = mode === undefined ? undefined : normalizeMilestoneMode(mode);
  const targetValue = target === undefined ? undefined : normalizeMilestoneTarget(target);
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const renamed = newName === undefined ? name : normalizeMilestoneText(newName).name;
    if (renamed !== name && entries.some((entry) => entry.name === renamed)) throw new Refused('MILESTONE_EXISTS', `milestone ${renamed} already exists; choose another name`);
    entries[index] = { ...entries[index], name: renamed, ...(note === undefined ? {} : { note: normalizeMilestoneText(renamed, note).note }) };
    if (targetValue !== undefined) entries[index].target = targetValue;
    if (limitValue !== undefined) {
      if (engine >= MILESTONE_PERSON_LIMIT_ENGINE && raisesLimit(entries[index].limit, limitValue) && !asPerson) {
        throw new Refused('MILESTONE_LIMIT_PERSON', `only the person raises a milestone limit (${name} is at ${entries[index].limit}); ask the person, who runs pullboard milestone edit ${JSON.stringify(name)} --limit <n>|none --as person in the main checkout`);
      }
      enforceMilestoneLimit(board, { ...entries[index], limit: limitValue }, entries[index].items, itemById);
      entries[index].limit = limitValue;
    }
    if (modeValue !== undefined) entries[index].mode = modeValue;
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_edit', null, { before: name, after: renamed, noteChanged: note !== undefined,
      ...(targetValue === undefined ? {} : { target: targetValue }), ...(limitValue === undefined ? {} : { limit: limitValue }), ...(modeValue === undefined ? {} : { mode: modeValue }) });
    return entries[index];
  });
}

/** Remove one milestone only; its referenced work items remain on their boards. */
export function removeMilestone(board, name, { agentId }, ports) {
  const { atomic, logEvent, milestones } = milestonePorts(ports, ["atomic", "logEvent", "milestones"]);
  requireCoordinator(agentId);
  return atomic(board, () => {
    const entries = milestones(board);
    const remaining = entries.filter((entry) => entry.name !== name);
    if (remaining.length === entries.length) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    saveMilestones(board, remaining);
    logEvent(board, agentId, 'milestone_remove', null, { name });
    return name;
  });
}

/**
 * Ship a milestone: record main's commit on it, keep the items that landed, and move every other
 * local item into the next milestone (the first unshipped one after it, or `next`), recording the
 * move on each item's thread. A withdrawn item stays, since it will never land; a repo#id
 * reference stays too, since its board, not this one, says whether it landed.
 *
 * @param {any} board
 * @param {string} name
 * @param {{ agentId: string, commit: string | null, next?: string, asPerson?: boolean, reason?: string, channel?: 'terminal' | 'view' }} options
 * @returns {{ milestone: any, into: string | null, moved: number[], notMoved: string[] }}
 */
export function shipMilestone(board, name, { agentId, commit, next, asPerson = false, reason, channel = 'terminal' }, ports) {
  const { atomic, itemById, listItems, logEvent, milestones } = milestonePorts(ports, ["atomic", "itemById", "listItems", "logEvent", "milestones"]);
  requireCoordinator(agentId);
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Refused('MILESTONE_COMMIT', "shipping records main's commit and main has none here; commit to main, then ship from the main checkout");
  }
  if ((asPerson || reason !== undefined) && (board.executionEngineVersion ?? ENGINE_VERSION) < COORDINATOR_ACTIONS_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording a project release override');
  }
  return atomic(board, () => {
    const entries = milestones(board);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Refused('NO_MILESTONE', `no milestone named ${name}; list them with pullboard roadmap`);
    const current = entries[index];
    if (current.shipped) throw shippedRefusal(current);
    const items = new Map(listItems(board, { all: true }).map((item) => [item.item_id, item]));
    const notMoved = current.items.filter((id) => typeof id === 'string');
    const stays = (id) => {
      const item = typeof id === 'number' ? items.get(id) : null;
      return !item || item.item_status === 'withdrawn' || roadmapState(item.item_status, isLanded(item)) === 'landed';
    };
    const moved = current.items.filter((id) => !stays(id));
    let into = null;
    if (next !== undefined) {
      into = entries.findIndex((entry) => entry.name === next);
      if (into < 0) throw new Refused('NO_MILESTONE', `no milestone named ${next}; list them with pullboard roadmap`);
      if (into === index) throw new Refused('MILESTONE_ORDER', 'choose a different milestone for --next than the one shipping');
      if (entries[into].shipped) throw shippedRefusal(entries[into]);
    } else if (moved.length) {
      into = entries.findIndex((entry, position) => position > index && !entry.shipped);
      if (into < 0) throw new Refused('NO_NEXT_MILESTONE', `no unshipped milestone follows ${name} to take its unlanded items; add one with pullboard milestone add, or name one with --next`);
    }
    const intoName = into === null ? null : entries[into].name;
    const at = board.clock.now().toISOString();
    if (into !== null) {
      const nextItems = [...entries[into].items, ...moved.filter(id => !entries[into].items.includes(id))];
      enforceMilestoneLimit(board, entries[into], nextItems, itemById);
      entries[into] = { ...entries[into], items: nextItems };
    }
    const coordinatorActions = (board.executionEngineVersion ?? ENGINE_VERSION) >= COORDINATOR_ACTIONS_ENGINE
      ? milestonePorts(ports, ['coordinatorMilestoneRelease']).coordinatorMilestoneRelease(board, { asPerson, reason, channel, plannedMoves: ['milestone_ship', ...moved.map(() => 'milestone_moved')] }) : null;
    entries[index] = { ...current, items: current.items.filter(stays), shipped: { commit, at, by: agentId } };
    saveMilestones(board, entries);
    logEvent(board, agentId, 'milestone_ship', null, { name, commit, into: intoName, moved, notMoved, ...(coordinatorActions ? { coordinatorActions } : {}) });
    for (const id of moved) {
      logEvent(board, agentId, 'milestone_moved', id, { from: name, to: intoName, commit,
        note: `moved from ${name} to ${intoName}: ${name} shipped at ${commit.slice(0, 12)} before this item landed` });
    }
    return { milestone: entries[index], into: intoName, moved, notMoved };
  });
}
