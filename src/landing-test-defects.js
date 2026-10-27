import { TEST_ECONOMICS_ENGINE } from './test-economics-engine.js';
import { auditFailureItem } from './test-economics.js';
import { landingTestDefects } from './landing-test-defect-history.js';
export { landingTestDefects };
/** Durable test defects hold a trunk when bisection identifies no item culprit [E29]. */
import {
  addItem,
  atomic,
  getItem,
  logEvent,
} from './board.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { LANDING_ENVIRONMENT_ENGINE } from './landing-environment-engine.js';
import { MAIN_AUDIT_ENGINE } from './main-audit-engine.js';
import { Refused } from './refused.js';


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
    const previous = landingTestDefects(board).find(defect => defect.branch === branch && defect.test === test && defect.hash === hash);
    const usable = (!audited || previous?.batchId === batchId) && (!requireOpen || !previous || ['open', 'claimed', 'submitted'].includes(getItem(board, previous.item).item_status));
    if (usable && previous?.batchId === batchId && names.every(name => previous.names.includes(name))) return previous;
    const item = (usable ? previous?.item : null) ?? addItem(board, { by: agentId, lane, title: audit?.title ?? `Landing test defect: ${test}`,
      criterion: audit?.criterion ?? `${test} passes with the combined accepted work; the landing failed without an item culprit: ${names.join('; ')}`, route: 'strong' });
    const defect = { test, hash, blob, trunkBlob, names: [...new Set([...(previous?.names ?? []), ...names])], item, batchId, branch, ...(audit ? { audit: audit.audit } : {}) };
    logEvent(board, agentId, 'landing-test-defect', item, { engine: audited ? TEST_ECONOMICS_ENGINE : requireOpen ? MAIN_AUDIT_ENGINE : LANDING_ENVIRONMENT_ENGINE, defect });
    return defect;
  });
}
