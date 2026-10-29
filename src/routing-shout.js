/** A shout cannot route work: routing is a rule the coordinator records, and the refusal prints the command [C7]. */
import { Refused } from './refused.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { PROOF_RUN_ENGINE } from './proof-run-engine.js';
import { ROUTING_RULES_ENGINE } from './routing-rules-engine.js';
import { refuseLongShout } from './proof-receipts.js';

const SEAT = String.raw`[a-z]+-\d+`;
const PATTERNS = [
  /\broute\s+#?\d+\s+to\b/iu,
  new RegExp(String.raw`\b(?:review|build)\s+(?:of\s+)?#\d+\b[^.\n]{0,60}\b${SEAT}\b`, 'iu'),
  new RegExp(String.raw`\b(?:assign|give|hand)\b[^.\n]{0,40}#\d+[^.\n]{0,40}\bto\s+(?:a\s+)?(?:${SEAT}|claude|codex|\w+\s+(?:reviewer|seat|family))\b`, 'iu'),
  new RegExp(String.raw`\b${SEAT}\s+(?:reviews?|builds?|takes?)\s+#\d+\b`, 'iu'),
  /#\d+[^.\n]{0,100}\b(?:goes|routed|assigned)\s+to\s+(?:a\s+)?\w+\s+(?:reviewer|seat|family)\b/iu,
];

/** Refuse assignment forms from every sender, including the coordinator; prose never sets routing data. */
export function refuseRoutingShout({ from, text }) {
  const direct = from === 'coordinator' && /\b(?:review|build|take|claim)\s+#\d+\b/iu.test(String(text));
  if (!direct && !PATTERNS.some(pattern => pattern.test(String(text)))) return;
  const id = /#(\d+)/u.exec(String(text))?.[1] ?? '<id>';
  throw new Refused('ROUTING_BY_SHOUT', `a shout cannot route work; the coordinator records a rule that next enforces: pullboard rule add review only-seat <seat> --item ${id} --source <shout-id> (effects: only-seat, bar-seat, require-family, bar-family, bar-pool, require-session, bar-session; act review, build or any). Ask for the rule with a question shout that states the rule, not the assignment.`);
}

/** Enforce current message protocol at the native writer; genuinely older replay keeps its guards. */
export function requireShoutProtocol(board, message) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine >= PROOF_RUN_ENGINE) refuseLongShout(message.text);
  if (engine >= ROUTING_RULES_ENGINE) refuseRoutingShout(message);
}
