/** Authenticated numeric claim counters require the exit-rule replay floor [B3,H16]. */
import { EXIT_RULES_ENGINE } from "../../../../state/light.js";
/** Keep fresh and replayed usage captures on the same engine. */
function minimumEngine() { return EXIT_RULES_ENGINE; }
/** Only this native seat may publish its per-claim progress. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'recordExitProgress', engine: EXIT_RULES_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({
    EXIT_USAGE: 'restore the original private claim anchor; unreadable or reset native counters must remain unknown',
    NOT_YOURS: 'shout its holder or the coordinator: pullboard shout coordinator --kind question "<what you need>"',
  }) });
