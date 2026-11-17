import { diagnosisBrief } from '../../../../items/index.js';
import { parseDiagnosis } from '../../../../items/index.js';
/** Keep native diagnosis custody alongside its immutable fact and bar [C7]. */
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Tell whether diagnosis admission is active for this move or read. */
export function diagnosisEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= TWO_TIER_DIAGNOSIS_ENGINE;
}

/** Read only a diagnosis for the exact current criterion and check, never a superseded bar. */
export function itemDiagnosis(board, item) {
  const source = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_diagnosis:${item.item_id}`)?.meta_value;
  if (!source) return briefDiagnosis(item);
  const diagnosis = JSON.parse(source);
  return diagnosis.criterion === item.item_criterion && diagnosis.check === item.item_check && item.item_brief === diagnosisBrief(diagnosis) ? diagnosis : null;
}

/** A brief already written as Files, Change and Test is its own diagnosis; one that does not parse is not. Why: 14 of the 62 light items in 0.9.4 were in that form and only needed recording, while light seats got nothing from next [C7]. */
export function briefDiagnosis(item) {
  try { return item.item_brief ? parseDiagnosis(item.item_brief) : null; } catch { return null; }
}

/** Prevent an undiagnosed light item or seat from slipping through an explicit claim or route edit. */
export function lightDiagnosisProblem(board, item, route = item.item_route) {
  return diagnosisEnabled(board) && route === 'light' && !itemDiagnosis(board, item)
    ? new Refused('DIAGNOSIS_REQUIRED', `#${item.item_id ?? 'new'} has no current diagnosis; keep it mid or strong, then have a capable seat record Files, Change and Test case with pullboard fact <id> diagnosis`) : null;
}
