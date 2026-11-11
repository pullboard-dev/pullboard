/** Bind slice creation to the requesting seat and its engine boundary [C7,B26,H16]. */
import { ITEM_SLICE_ENGINE } from '../../../../state/light.js';
function minimumEngine() { return ITEM_SLICE_ENGINE; }
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'createItemSlice', engine: ITEM_SLICE_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
