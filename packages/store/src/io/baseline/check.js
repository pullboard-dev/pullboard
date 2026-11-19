import { itemCheckBaseline } from "../board/query.js";
export { itemCheckBaseline } from "../board/query.js";
/** Baseline observations and their immutable completion fences [V2,H16]. */
import {
  atomic,
  itemById,
  logEvent,
} from "../board.js";
import { COORDINATOR } from "../../../../config/index.js";
import { holdItem } from "../board/hold/item.js";
import { releaseItemHold } from "../board/release/hold.js";
import { Refused } from "../../../../kernel/index.js";
import { PROVES_NOTHING_HOLD_REASON } from "../../../../verify/index.js";
import { checkAcceptance } from "../../../../verify/index.js";

import { coordinatorCheck } from "../../../../verify/index.js";
export { coordinatorCheck } from "../../../../verify/index.js";

/** Keep each failing case's file and name, bounded; a malformed entry names nothing (#2594). */
function failedCasesOf(rows) {
  return rows.filter(row => row && typeof row.file === 'string' && row.file.length <= 4096 && typeof row.name === 'string' && row.name.length <= 4096)
    .slice(0, 512).map(row => ({ file: row.file, name: row.name }));
}

/** Validate captured baseline data without asking a replica to run Git or a shell [V2,H16]. */
export function normalizeCheckBaseline(agentId, command, baseline, { authorized = false } = {}) {
  if (baseline === undefined) return undefined;
  coordinatorCheck(authorized ? COORDINATOR : agentId, command ?? '');
  if (!command || !baseline || typeof baseline !== 'object' || Array.isArray(baseline)
    || baseline.command !== command || !['green', 'red', 'unavailable', 'pending'].includes(baseline.result)
    || !(baseline.main === null || typeof baseline.main === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.main))
    || (baseline.result !== 'unavailable' && baseline.main === null)
    || (baseline.result === 'pending' && !baseline.request)
    || (baseline.request !== undefined && (typeof baseline.request !== 'string' || !/^[a-f0-9-]{36}$/.test(baseline.request)))
    || (baseline.reason !== undefined && typeof baseline.reason !== 'string')
    || (baseline.testEvidence !== undefined && (!baseline.testEvidence || typeof baseline.testEvidence.noTestsMatched !== 'boolean'
      || !['failed','passed'].every(key => Array.isArray(baseline.testEvidence[key]) && baseline.testEvidence[key].length <= 512 && baseline.testEvidence[key].every(name => typeof name === 'string' && name.length <= 4096))))
    || (baseline.strict !== undefined && typeof baseline.strict !== 'boolean')
    || (baseline.seconds !== undefined && (!Number.isSafeInteger(baseline.seconds) || baseline.seconds < 0))) {
    throw new Refused('BAD_CHECK_BASELINE', 'the check baseline must describe this command at a main commit; set --check again from the coordinator');
  }
  return {
    command, main: baseline.main, result: baseline.result,
    ...(baseline.request === undefined ? {} : { request: baseline.request }),
    ...(baseline.reason === undefined ? {} : { reason: baseline.reason }),
    ...(baseline.testEvidence === undefined ? {} : { testEvidence: { failed: [...baseline.testEvidence.failed], passed: [...baseline.testEvidence.passed],
      ...(Array.isArray(baseline.testEvidence.failedCases) ? { failedCases: failedCasesOf(baseline.testEvidence.failedCases) } : {}),
      noTestsMatched: baseline.testEvidence.noTestsMatched } }),
    ...(baseline.seconds === undefined ? {} : { seconds: baseline.seconds }),
    ...(baseline.strict === undefined ? {} : { strict: baseline.strict }),
    ...(baseline.result === 'green' ? { warning: 'CRITERION_PROVES_NOTHING' } : {}),
  };
}

/** The hold reason an item gets when its first baseline shows its check already passes on main (#5709). */
export { PROVES_NOTHING_HOLD_REASON };

/**
 * Record a captured result only for the still-current authorized background request [V2,H16]. With holdProvesNothing
 * (main's checks.provesNothing is "hold"), a green result also holds an open or claimed item, so next never offers a
 * bar that cannot fail (#5709), unless the person already accepted that exact check; the flag rides in the move's own arguments, so a replay holds exactly when it did.
 * A red result lifts that proves-nothing hold, whatever the setting: the check now fails first, so the item has real
 * work, and a hold nothing else lifts would strand it (P7, #6187).
 */
export function completeCheckBaseline(board, id, { agentId, expected, baseline, holdProvesNothing = false }) {
  return atomic(board, () => {
    const result = normalizeCheckBaseline(agentId, baseline?.command, baseline);
    if (!expected || !result || result.result === 'pending' || result.command !== expected.command || result.main !== expected.main
      || typeof expected.request !== 'string' || !/^[a-f0-9-]{36}$/.test(expected.request)) {
      throw new Refused('BAD_CHECK_BASELINE', 'a completed baseline must match its authorized request; set --check again from the coordinator');
    }
    const item = itemById(board, id);
    const current = itemCheckBaseline(board, item);
    if (current?.result !== 'pending' || current.request !== expected.request || current.command !== expected.command || current.main !== expected.main) return false;
    // A check is strict when its pending baseline said so; the completing result never decides it, so the flag rides from the pending record to the completed one.
    const recorded = { ...result, request: expected.request };
    delete recorded.strict;
    if (current.strict !== undefined) recorded.strict = current.strict;
    saveCheckBaseline(board, id, recorded);
    logEvent(board, agentId, 'check-baseline', id, { checkBaseline: recorded });
    if (holdProvesNothing === true && recorded.result === 'green' && ['open', 'claimed'].includes(item.item_status) && !item.item_hold_reason
      && !checkAcceptance(board, item)) { // the person accepted this exact check while its baseline was pending
      holdItem(board, id, { agentId: COORDINATOR, reason: PROVES_NOTHING_HOLD_REASON });
    }
    if (recorded.result === 'red' && item.item_hold_reason === PROVES_NOTHING_HOLD_REASON) {
      releaseItemHold(board, id, { agentId: COORDINATOR });
    }
    return true;
  });
}

/** Store or clear an item's observation atomically with its check and immutable audit event. */
export function saveCheckBaseline(board, id, baseline) {
  const key = `item_check_baseline_${id}`;
  if (!baseline) board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(key);
  else board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(baseline));
}

/** Read the current check's setter from immutable edits, or its original item author [V2]. */
export function itemCheckAuthor(board, id) {
  const item = itemById(board, id);
  const edits = board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'edit' ORDER BY event_id DESC").all(id);
  for (const edit of edits) {
    let detail;
    try { detail = JSON.parse(edit.event_detail); }
    catch { return null; }
    if (detail && Object.hasOwn(detail, 'check')) return detail.check === item.item_check ? edit.event_by : null;
  }
  return item.item_created_by;
}

/** The id of an item whose recorded baseline shows this exact command green at this main commit, or null [V2]. */
export function knownGreenBaseline(board, command, main) {
  for (const row of board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'item_check_baseline_%'").all()) {
    let seen;
    try { seen = JSON.parse(row.meta_value); } catch { continue; }
    if (seen?.result === 'green' && seen.command === command && seen.main === main) return Number(row.meta_key.slice('item_check_baseline_'.length));
  }
  return null;
}

/**
 * Refuse a check that a board observation already shows passing on today's main, unless the author says why it stays.
 * The observation is one the board already holds; no command runs here.
 *
 * @param {any} board
 * @param {{ command: string, main: string|null }} baseline - the prepared baseline for the new check
 * @param {string|undefined} accepted - the author's reason from --accept-green
 */
export function guardGreenCheck(board, baseline, accepted) {
  if (!baseline?.main || accepted?.trim()) return;
  const seen = knownGreenBaseline(board, baseline.command, baseline.main);
  if (!seen) return;
  throw new Refused('CRITERION_PROVES_NOTHING', `this check already passes on main ${String(baseline.main).slice(0, 12)} (seen on #${seen}), so it proves nothing: ${baseline.command}`,
    'use a check that fails before the work and passes after it, such as one that runs the new test; if a passing check is right (a guard against a regression), run the command again with --accept-green "why it stays"');
}
