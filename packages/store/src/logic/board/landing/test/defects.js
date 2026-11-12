import { TEST_ECONOMICS_ENGINE } from "../../../../../../state/light.js";
import { auditFailureItem } from "../../../../../../items/index.js";
import { landingTestDefects } from "./history.js";
export { landingTestDefects };
/** Durable test defects hold a trunk when bisection identifies no item culprit [E29]. */
import {
  addItem,
  atomic,
  getItem,
  logEvent,
  appendFact,
} from "../../../../io/board.js";
import { COORDINATOR } from "../../../../../../config/index.js";
import { ENGINE_VERSION } from "../../../../../../state/index.js";
import { LANDING_ENVIRONMENT_ENGINE } from "../../../../../../state/light.js";
import { MAIN_AUDIT_ENGINE } from "../../../../../../state/light.js";
import { LANDING_DEFECT_CLOSE_ENGINE } from "../../../../../../state/light.js";
import { Refused } from "../../../../../../kernel/light.js";


/** File a neutral repair item: an interaction is not proof that a named item or test is flaky. */
export function recordLandingTestDefect(board, { agentId, test, hash, blob, trunkBlob, names, lane, batchId, branch, requireOpen, auditSinceEventId }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator files a landing test defect');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_ENVIRONMENT_ENGINE) throw new Refused('ENGINE_VERSION', `landing test defects require engine ${LANDING_ENVIRONMENT_ENGINE}`);
  if (requireOpen !== undefined && requireOpen !== true) throw new Refused('LAND_TEST_DEFECT', 'requireOpen must be true when supplied');
  if (requireOpen && (board.executionEngineVersion ?? ENGINE_VERSION) < MAIN_AUDIT_ENGINE) throw new Refused('ENGINE_VERSION', `open audit repairs require engine ${MAIN_AUDIT_ENGINE}`);
  if (typeof test !== 'string' || test.length > 4096 || /[\r\n\0]/u.test(test) || test.startsWith('/') || test.includes('\\') || test.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{64}$/u.test(hash ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(blob ?? '')
    || trunkBlob !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(trunkBlob ?? '')
    || !Array.isArray(names) || !names.length || names.length > 500 || names.some(name => typeof name !== 'string' || !name || name.length > 8192 || /[\r\n\0]/u.test(name))
    || typeof batchId !== 'string' || !(requireOpen ? /^[a-zA-Z0-9_-]{1,80}$/u : /^[a-f0-9-]{36}$/u).test(batchId) || typeof branch !== 'string' || !branch || branch.length > 1024 || /[\r\n\0]/u.test(branch)) {
    throw new Refused('LAND_TEST_DEFECT', 'a landing test defect needs its exact test, source identity, failures, batch and trunk');
  }
  const audited = auditSinceEventId !== undefined;
  if (audited && (!requireOpen || !Number.isSafeInteger(auditSinceEventId) || auditSinceEventId < 0)) throw new Refused('LAND_TEST_DEFECT', 'an audit needs its last green native event cursor');
  if (audited && (board.executionEngineVersion ?? ENGINE_VERSION) < TEST_ECONOMICS_ENGINE) throw new Refused('ENGINE_VERSION', `audit provenance requires engine ${TEST_ECONOMICS_ENGINE}`);
  return atomic(board, () => {
    let audit = null;
    if (audited) {
      const states = new Map(), landings = [];
      for (const row of board.db.prepare("SELECT event_id,event_detail FROM event WHERE event_kind='landing_batch' ORDER BY event_id").all()) {
        const batch = JSON.parse(row.event_detail).batch, previous = states.get(batch.id);
        states.set(batch.id, batch.state);
        if (batch.state === 'landed' && previous !== 'landed') landings.push({ eventId: row.event_id, commit: batch.tip, items: batch.items.map(entry => entry.id) });
      }
      const target = landings.find(row => row.commit && row.eventId > auditSinceEventId && row.items.length);
      if (!target) throw new Refused('LAND_TEST_DEFECT', 'an audit must name native landings after its last green cursor');
      audit = auditFailureItem({ failures: names.map(name => ({ file: test, name })), landings, sinceEventId: auditSinceEventId, lane });
    }
    // The cause key is lane plus test file: a changed hash is new evidence for the same item, never a new item [C7].
    const previous = landingTestDefects(board).find(defect => defect.branch === branch && defect.test === test && (defect.lane ?? lane) === lane);
    const live = previous && ['open', 'claimed', 'submitted'].includes(getItem(board, previous.item).item_status);
    const reuse = previous && live && (!audited || previous.batchId === batchId) ? previous : null;
    if (reuse && reuse.hash === hash && reuse.batchId === batchId && names.every(name => reuse.names.includes(name))) return reuse;
    const item = reuse?.item ?? addItem(board, { by: agentId, lane, title: audit?.title ?? `Landing test defect: ${test}`,
      criterion: audit?.criterion ?? `${test} passes with the combined accepted work; the landing failed without an item culprit: ${names.join('; ')}`, route: 'strong' });
    if (reuse && (reuse.hash !== hash || names.some(name => !reuse.names.includes(name)))) {
      appendFact(board, item, { agentId, kind: 'note', text: `Landing failed again in ${test} at hash ${hash}: ${names.join('; ')}` });
    }
    const defect = { test, hash, blob, trunkBlob, lane, names: [...new Set([...(reuse?.names ?? []), ...names])], item, batchId, branch, ...(audit ? { audit: audit.audit } : {}) };
    logEvent(board, agentId, 'landing-test-defect', item, { engine: audited ? TEST_ECONOMICS_ENGINE : requireOpen ? MAIN_AUDIT_ENGINE : LANDING_ENVIRONMENT_ENGINE, defect });
    return defect;
  });
}

/**
 * Close an open trunk test defect once its recorded failing cases passed in a recorded run at a trunk commit, so it no
 * longer holds landings at later trunk commits; a later red of the same cases files a new defect that holds again [C7].
 * Why: the release read a recorded run at the current trunk tip only, and every landing moves the tip, so the automatic
 * lander refused #3304 LAND_TEST_DEFECT again one landing after its cases passed (#3694). Closing an already closed or
 * replaced defect records nothing and returns null.
 */
export function closeLandingTestDefect(board, { agentId, branch, test, item, commit }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator closes a landing test defect');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_DEFECT_CLOSE_ENGINE) throw new Refused('ENGINE_VERSION', `closing landing test defects requires engine ${LANDING_DEFECT_CLOSE_ENGINE}`);
  if (typeof branch !== 'string' || !branch || branch.length > 1024 || /[\r\n\0]/u.test(branch)
    || typeof test !== 'string' || !test || test.length > 4096 || /[\r\n\0]/u.test(test)
    || !Number.isSafeInteger(item) || item < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) {
    throw new Refused('LAND_TEST_DEFECT', 'closing a landing test defect needs its trunk branch, test, repair item and the trunk commit its cases passed at');
  }
  return atomic(board, () => {
    if (!landingTestDefects(board).some(defect => defect.branch === branch && defect.test === test && defect.item === item)) return null;
    const closed = { branch, test, item, commit };
    logEvent(board, agentId, 'landing-test-defect-closed', item, { engine: LANDING_DEFECT_CLOSE_ENGINE, closed });
    return closed;
  });
}
