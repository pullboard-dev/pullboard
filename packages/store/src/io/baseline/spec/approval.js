import {
  KEY,
  validBaseline,
  canonicalBaseline,
  specApprovalBaselineExists,
  specApprovalBaseline,
} from "../../board/query.js";
/** One shared compatibility snapshot, recorded through the board engine, never a person approval. */
import {
  atomic,
  logEvent,
} from "../../board.js";
import { Refused } from "../../../../../kernel/index.js";
import { parseSpec } from "../../../../../spec/index.js";
import { COORDINATOR } from "../../../../../config/index.js";



export { specApprovalBaselineExists } from "../../board/query.js";





export { specApprovalBaseline } from "../../board/query.js";

/** Persist the first ordered snapshot once; later setup or competing replicas cannot expand it. */
export function recordSpecApprovalBaseline(board, { agentId, baseline }) {
  return atomic(board, () => {
    if (agentId !== COORDINATOR) {
      throw new Refused('COORDINATOR_ONLY', 'only the coordinator or person establishes the approval baseline from the main checkout; lane work may continue while it is pending');
    }
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(agentId)) {
      throw new Refused('NOT_JOINED', 'join a lane before recording the board approval baseline');
    }
    const existing = specApprovalBaseline(board);
    if (existing) return existing;
    if (!validBaseline(baseline)) throw new Refused('SPEC_APPROVAL_BASELINE', 'an approval baseline needs its exact approved source rows; retry from the coordinator checkout');
    const value = canonicalBaseline(baseline);
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(KEY, JSON.stringify(value));
    logEvent(board, agentId, 'spec_approval_baseline', null, value);
    return value;
  });
}
