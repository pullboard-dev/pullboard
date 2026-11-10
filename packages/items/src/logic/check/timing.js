/** Coordinator-owned timing declarations, frozen with the check rather than supplied by its executor [C7,V4]. */
import { Refused } from "../../../../kernel/light.js";
import { CHECK_TIMING_ENGINE } from "../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../state/light.js";

/** Validate an explicitly authored flag without accepting truthy strings or historical engines. */
export function validateCheckTiming(board, actor, value) {
  if (value === undefined) return;
  if (actor !== 'coordinator') throw new Refused('COORDINATOR_CHECK', 'only the coordinator sets check timing; ask the coordinator to edit --check-timing true|false');
  if (typeof value !== 'boolean') throw new Refused('BAD_CHECK', 'check timing is a boolean; use --check-timing true or --check-timing false');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < CHECK_TIMING_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before setting check timing');
}

/** Persist only an explicitly supplied declaration in replicated board metadata. */
export function saveCheckTiming(board, id, value) {
  if (value === undefined) return;
  board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key,meta_value) VALUES (?,?)').run(`item_check_timing:${id}`, JSON.stringify(value));
}

/** Read timing only from the captured criterion; an absent historical flag remains false. */
export function frozenCheckTiming(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); } catch { return false; }
  return frozen?.checkTiming === true;
}

/** Parse the explicit CLI boolean; the string "false" must never enable exclusive admission. */
export function parseCheckTiming(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Refused('USAGE', '--check-timing takes true or false');
}

/** Refuse old clients before they can freeze or execute a modern timing-sensitive bar. */
export function checkTimingEngine(board, id) {
  if (!board || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return 1;
  const row = board.db.prepare("SELECT item_frozen, timing.meta_value AS timing FROM item LEFT JOIN board_meta timing ON timing.meta_key='item_check_timing:' || item.item_id WHERE item_id=?").get(id);
  return row && (row.timing === 'true' || frozenCheckTiming(row)) ? CHECK_TIMING_ENGINE : 1;
}
