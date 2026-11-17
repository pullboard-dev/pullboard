/** Native snapshot projection uses the same lifecycle fields as the local API [A2,H17]. */
import {
  itemSummary,
  withListFields,
} from "../../../../items/light.js";
import { encodePagedSnapshot } from "./layout.js";

/**
 * A first-screen row keeps an item's typed fields and related ids only when it has some (#9358, #1321) [C7].
 * Why only when set: a row of an item with none keeps exactly the keys it had, so the sealed bytes do not change.
 */
function withLinks(item, summary) {
  return { ...summary, ...(item.fields?.length ? { fields: item.fields } : {}), ...(item.relatedIds?.length ? { relatedIds: item.relatedIds } : {}) };
}

/** Project current list fields without pulling the native lifecycle implementation into phone readers. */
function projectList(state, tables) {
  const leases = new Map((tables.item ?? []).map(row => [row.item_id, row.item_lease_until ?? null]));
  const listed = withListFields(state, leases).state;
  return { ...listed, items: listed.items.map(item => withLinks(item, itemSummary(item))) };
}

/** Seal an importable native snapshot and canonical bounded phone summaries. */
export async function writePagedSnapshot(document, context) {
  return encodePagedSnapshot(document, context, projectList);
}
