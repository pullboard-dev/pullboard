/** A shout cannot route work: routing is a rule the coordinator records, and the refusal prints the command [C7]. */
import { Refused } from './refused.js';

const SEAT = String.raw`[a-z]+-\d+`;
const PATTERNS = [
  /\broute\s+#?\d+\s+to\b/iu,
  new RegExp(String.raw`\b(?:review|build)\s+(?:of\s+)?#\d+\b[^.\n]{0,60}\b${SEAT}\b`, 'iu'),
  new RegExp(String.raw`\b(?:assign|give|hand)\b[^.\n]{0,40}#\d+[^.\n]{0,40}\bto\s+(?:a\s+)?(?:${SEAT}|claude|codex|\w+\s+(?:reviewer|seat|family))\b`, 'iu'),
];

/** Refuse an agent's coordinator-bound shout that assigns review or build of an item to a seat or family. */
export function refuseRoutingShout({ from, to, text }) {
  if (from === 'person' || from === 'coordinator' || to !== 'coordinator') return;
  if (!PATTERNS.some(pattern => pattern.test(String(text)))) return;
  const id = /#(\d+)/u.exec(String(text))?.[1] ?? '<id>';
  throw new Refused('ROUTING_BY_SHOUT', `a shout cannot route work; the coordinator records a rule that next enforces: pullboard rule add review only-seat <seat> --item ${id} --source <shout-id> (effects: only-seat, bar-seat, require-family, bar-family, bar-pool, require-session, bar-session; act review, build or any). Ask for the rule with a question shout that states the rule, not the assignment.`);
}
