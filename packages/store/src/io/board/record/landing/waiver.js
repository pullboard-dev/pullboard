import { PERSON } from "../../query.js";
import { atomic } from "../../event/log.js";
import { logEvent } from "../../event/log.js";
import { Refused } from "../../../../../../kernel/index.js";

/** Record the person's expiring exception for one named failing test [B3,R3]. */
export function recordLandingWaiver(board, { agentId, channel, id, test, until, reason }) {
  if (agentId !== PERSON) throw new Refused('LAND_PERSON_ONLY', 'only the person waives a flaky test; use the person’s terminal or Pullboard View');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'waivers use the person’s terminal or view; run pullboard view');
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id) || typeof test !== 'string' || !test.trim()
    || test.startsWith('/') || test.includes('\\') || test.split('/').some((part) => !part || part === '..' || part === '.')
    || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= board.clock.now().getTime() || typeof reason !== 'string' || !reason.trim()) {
    throw new Refused('LAND_WAIVER', 'name a test, a future --until date and a nonempty --reason; run pullboard land --waive <test> --until <date> --reason "why"');
  }
  return atomic(board, () => {
    // This ordered result and event retain their released shape on every replay engine.
    // File/name classification belongs to a derived read, never immutable waiver history.
    const waiver = { id, test, until: new Date(until).toISOString(), reason: reason.trim(), by: PERSON, channel };
    logEvent(board, PERSON, 'landing_waiver', null, { waiver });
    return waiver;
  });
}
