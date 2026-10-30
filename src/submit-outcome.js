/** Observational refusal metadata renews only its existing live claim and grants no proof authority [V4,H16]. */
import { Refused } from './refused.js';
import { PIPELINE_CAUSE_ENGINE } from './pipeline-cause-engine.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { pipelineCause } from './pipeline-cause.js';

/** Validate on both origin and replay before the ordinary claim guards execute. */
export function checkedSubmitOutcome(board, id, actor, value, admission) {
  if (value == null) return null;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PIPELINE_CAUSE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording typed submit outcomes');
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (admission || item?.item_status !== 'claimed' || item.item_owner !== actor || !(item.item_lease_until > board.clock.now().toISOString())
    || value.digest !== item.item_frozen_digest) throw new Refused('ITEM_LEASE_LOST', 'a submit outcome needs its original live claim and unchanged frozen bar');
  if (!/^[A-Z][A-Z0-9_]*$/u.test(value.code ?? '') || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000)
    throw new Refused('USAGE', 'a submit outcome retains its actual refusal code and bounded explanation');
  return { code: value.code, text: value.text, digest: value.digest, pipelineCause: pipelineCause({ code: value.code, note: value.text }) };
}
