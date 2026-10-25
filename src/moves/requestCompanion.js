/** Cross-lane requests have one authenticated actor and their own replay boundary [B2,B12,H16]. */
import { COMPANION_ENGINE } from '../companion-engine.js';

/** Earlier moves cannot create companion children. */
function minimumEngine() { return COMPANION_ENGINE; }

/** Bind the request to the joined seat that asks for it. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'requestCompanion', engine: COMPANION_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
