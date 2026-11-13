/** Native item-patch history read from rows already loaded, with no node: built-in, so move declarations stay process-free [C7,V4,H16]. */
import { ENGINE_VERSION } from "../../../../state/light.js";
import { ITEM_PATCH_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/browser.js";
const PREFIX = 'item_patches:';

/** Read immutable native history without importing board opening or write orchestration. */
export function itemPatchRecords(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_ENGINE || !Number.isSafeInteger(id) || id < 1) return [];
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + id);
  if (!row) return [];
  const saved = JSON.parse(row.meta_value);
  if (saved.version !== 1 || !Array.isArray(saved.patches)) throw new Refused('ITEM_PATCH_FORMAT', 'restore the native item patch metadata before reviewing');
  return saved.patches;
}
/** Return active patches in native attachment order, with independent result objects. */
export function itemPatches(board, id) { return structuredClone(itemPatchRecords(board, id).filter(record => record.active)); }
