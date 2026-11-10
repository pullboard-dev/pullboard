/** Routing owned by fileTypedRequest; queue data never executes coordinator operations [N26,B3,H16]. */
import { TYPED_REQUESTS_ENGINE } from "../../../../state/light.js";
/** The new payload has no historical interpretation. */
function minimumEngine() { return TYPED_REQUESTS_ENGINE; }
/** Credential selection uses the exact native requester/coordinator argument. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'fileTypedRequest', order: 10010, engine: TYPED_REQUESTS_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    BAD_TYPED_REQUEST: 'use request reopen|hold|withdraw|reroute <id> --cause <key>, or request answer <ids> done|declined',
    BAD_REQUEST_CAUSE: 'choose a fixed cause key from pullboard help request',
    REQUEST_NOT_ACTED: 'run the original coordinator move, then name its exact native event with --acted-on',
    NO_TYPED_REQUEST: 'list queued requests with pullboard request list --all',
    REQUEST_ALREADY_ANSWERED: 'read the recorded answer with pullboard request list --all'
  }) });
