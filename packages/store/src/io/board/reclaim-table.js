/** The reclaim move table run beside the store's stale-state maintenance writer, so its answer is compared with the events maintenance wrote [C7,#9367]. */
import { runReclaimTable } from '../../logic/board/landing/lease.js';
import { firstDifference } from './shadow-record.js';

/** A maintenance event reduced to what the table decides, as plain JSON so an absent key and an undefined one read alike; the actor's model is the event writer's stamp, not the table's. */
function decidedEvent({ kind, by, detail }) {
  const { model, ...rest } = JSON.parse(JSON.stringify(typeof detail === 'string' ? JSON.parse(detail) : detail ?? {}));
  return { kind, by, detail: rest };
}

/**
 * The reclaim table's answer for one maintenance row the writer has just handled, over the facts the writer captured and re-checked.
 * Why a copy: the table must never see, or change, the writer's own objects.
 *
 * @param {object} snapshot - The item, its owner's last claim and lease, waited-on deps, reservation and progress as the writer re-checked them.
 * @param {object} move - `{ kind, maintainer, observedAt, row, limits, now, ... }`.
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[] } | { threw: string }}
 */
export function reclaimDecision(snapshot, move) {
  try { return runReclaimTable(structuredClone(snapshot), structuredClone(move)); } catch (error) { return { threw: error?.code ?? String(error?.message ?? error) }; }
}

/**
 * Where the reclaim table's answer and the events maintenance wrote part: `refused` when the table refused a row the writer acted on,
 * else the first differing path between the two event lists, or null when they agree.
 */
export function reclaimDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused) return 'refused';
  return firstDifference((decided?.events ?? []).map(decidedEvent), wrote.map(decidedEvent), 'events');
}
