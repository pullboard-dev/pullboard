/** Observational refusal metadata renews only its existing live claim and grants no proof authority [V4,H16]. */
import { Refused } from "../../../../kernel/index.js";
import { pipelineCause } from "../../../../kernel/index.js";
import { runSubmitTable } from "../../logic/board/landing/lease.js";
import { INFRASTRUCTURE_CODES } from "./handoff/retry.js";
import { INFRASTRUCTURE_RETRY_LIMIT } from "./handoff/retry.js";
import { shadowHook } from "../board/shadow-record.js";
import { shadowDecide } from "../board/shadow-record.js";
import { firstDifference } from "../board/shadow-record.js";
import { shadowSetting } from "../board/submit.js";
import { movesLiveEnabled } from "../../../../config/index.js";

/** Recorder compares waiting for their claim to commit, keyed by the outcome the plan carries to the claim writer [C7,#8380]. */
const PENDING = new WeakMap();

/**
 * What the OUTCOME table says a refusal renewal does over the board as it stands: the detail it records, nothing (`skipped`), or its refusal.
 * Why: the writer's own checks and the table must give one answer, and the shadow compare shows it [C7,#8271].
 *
 * @returns {{ refused?: object, skipped?: true, recorded?: object }}
 */
export function outcomeDecision(board, id, actor, value) {
  const row = board.db.prepare('SELECT item_status, item_owner, item_lease_until, item_frozen_digest FROM item WHERE item_id=?').get(id);
  const snapshot = { now: board.clock.now().toISOString(), actor: { id: actor }, item: row ? { id, status: row.item_status, owner: row.item_owner, leaseUntil: row.item_lease_until, frozenDigest: row.item_frozen_digest } : null };
  const move = { id, actor, digest: value.digest, stage: value.stage, refusal: { code: value.code, text: value.text } };
  const answer = runSubmitTable('OUTCOME', { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, snapshot, move);
  if (answer.refused) return { refused: { code: answer.refused.code, message: answer.refused.message, next: answer.refused.next } };
  if (answer.via[0] === 'skip') return { skipped: true };
  return { recorded: answer.table.outcomes.find(o => o.id === 'renew').submitOutcome(snapshot, move) };
}

/**
 * Validate on both origin and replay before the ordinary claim guards execute.
 * A board that carries `submitOutcomeShadow` is handed the table's answer beside what this wrote or refused with, for the store test to compare [C7,#8271].
 * With moves.shadow on and no such hook, the compare is recorded on the board when the claim commits, by `recordPendingOutcome`;
 * a refusal never commits, so its compare is recorded now [C7,#8380].
 */
export function checkedSubmitOutcome(board, id, actor, value, admission) {
  // With moves.live.outcome on (a board's own `movesLive.outcome` stands in for the setting in a store test), the OUTCOME table decides:
  // it refuses, or skips a renewal on a claim that moved on, before anything is recorded, and the outcome it names is the one kept [C7,#8386].
  if (value != null && (board.movesLive?.outcome ?? movesLiveEnabled('outcome')) === true) return tableSubmitOutcome(board, id, actor, value, admission);
  const hook = value == null ? null : shadowHook(board, 'submitOutcomeShadow', 'outcome', outcomeDiffers, shadowSetting);
  if (!hook) return writeSubmitOutcome(board, id, actor, value, admission);
  const decided = shadowDecide(hook, () => outcomeDecision(board, id, actor, value));
  let wrote;
  try { wrote = { recorded: writeSubmitOutcome(board, id, actor, value, admission) }; } catch (error) { wrote = { refused: { code: error.code, message: error.message } }; }
  if (hook.recorder && !wrote.refused) PENDING.set(wrote.recorded, { hook, answer: { id, decided, wrote } });
  else hook({ id, decided, wrote });
  if (wrote.refused) throw new Refused(wrote.refused.code, wrote.refused.message);
  return wrote.recorded;
}

/** The outcome as the OUTCOME table decides it; the engine floor and an admission claim, which the table does not model, keep the writer's own refusals [C7,#8386]. */
function tableSubmitOutcome(board, id, actor, value, admission) {
  const engines = board.enginePorts.pipelineCauseEngines();
  if ((board.executionEngineVersion ?? engines.current) < engines.pipeline) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording typed submit outcomes');
  if (admission) throw new Refused('ITEM_LEASE_LOST', 'a submit outcome needs its original live claim and unchanged frozen bar');
  const decided = outcomeDecision(board, id, actor, value);
  if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
  if (decided.skipped) throw new Refused('ITEM_LEASE_LOST', 'a submit outcome needs its original live claim and unchanged frozen bar');
  return decided.recorded;
}

/** Record the compare a claim's outcome waited on; the claim writer calls it inside its own board write, so the compare lands with the claim [C7,#8380]. */
export function recordPendingOutcome(outcome) {
  const pending = outcome ? PENDING.get(outcome) : null;
  if (!pending) return;
  PENDING.delete(outcome);
  pending.hook(pending.answer);
}

/** Where the OUTCOME table's answer and the outcome writer's part: the first differing path, or null when they agree. */
export function outcomeDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (wrote.refused) {
    // The table skips a renewal on a claim that moved on, and the writer refuses it: one answer in two forms.
    const same = decided.skipped ? wrote.refused.code === 'ITEM_LEASE_LOST' : decided.refused?.code === wrote.refused.code;
    return same ? null : 'refused';
  }
  if (decided.skipped || decided.refused) return decided.skipped ? 'skipped' : 'refused';
  return firstDifference(JSON.parse(JSON.stringify(decided.recorded ?? null)), JSON.parse(JSON.stringify(wrote.recorded)), 'recorded');
}

/** The writer's own checks and the outcome it records. */
function writeSubmitOutcome(board, id, actor, value, admission) {
  if (value == null) return null;
  const engines = board.enginePorts.pipelineCauseEngines();
  if ((board.executionEngineVersion ?? engines.current) < engines.pipeline) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording typed submit outcomes');
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (admission || item?.item_status !== 'claimed' || item.item_owner !== actor || !(item.item_lease_until > board.clock.now().toISOString())
    || value.digest !== item.item_frozen_digest) throw new Refused('ITEM_LEASE_LOST', 'a submit outcome needs its original live claim and unchanged frozen bar');
  if (!/^[A-Z][A-Z0-9_]*$/u.test(value.code ?? '') || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000)
    throw new Refused('USAGE', 'a submit outcome retains its actual refusal code and bounded explanation');
  return { code: value.code, text: value.text, digest: value.digest, ...(value.stage === 'fast' ? { stage: 'fast' } : {}), pipelineCause: pipelineCause({ code: value.code, note: value.text }) };
}
