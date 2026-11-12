/** Native snapshot projection uses the same lifecycle fields as the local API [A2,H17]. */
import {
  itemSummary,
  withListFields,
} from "../../../../items/light.js";
import { encodePagedSnapshot } from "./layout.js";

/** Project current list fields without pulling the native lifecycle implementation into phone readers. */
function projectList(state, tables) {
  const leases = new Map((tables.item ?? []).map(row => [row.item_id, row.item_lease_until ?? null]));
  const listed = withListFields(state, leases).state;
  return { ...listed, items: listed.items.map(itemSummary) };
}

/** Seal an importable native snapshot and canonical bounded phone summaries. */
export async function writePagedSnapshot(document, context) {
  return encodePagedSnapshot(document, context, projectList);
}
