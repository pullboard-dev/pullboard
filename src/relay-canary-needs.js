/** Project this checkout's active relay-canary alert into its local Needs-you list [H5,H15,C7]. */
import { readRelayHealth } from './relay-canary-health.js';
import { readOutboxCount } from './relay-outbox-summary.js';
import { relayLinkFile } from './local-state.js';
import { repoInfo } from './git.js';

/** Count only this local link's queued moves; status is read-only and never contacts the relay. */
function queuedMoves(root) {
  try { return readOutboxCount(relayLinkFile(repoInfo(root).commonDir)); }
  catch { return 0; }
}

/** Keep private client telemetry local, so a publishing host's probe never enters a sealed presentation. */
export function relayCanaryNeeds(root) {
  const health = readRelayHealth(root, { queued: queuedMoves(root) });
  if (typeof health.alertSince !== 'string' || !Number.isFinite(Date.parse(health.alertSince))) return [];
  const step = typeof health.step === 'string' && /^[a-z-]{1,24}$/u.test(health.step) ? health.step : 'unknown';
  const code = typeof health.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(health.code) ? health.code : 'RELAY_CANARY_FAILURE';
  const time = health.alertSince.slice(11, 16);
  const queued = health.queued;
  const detail = health.p95Ms !== null && health.p95Ms > 2000
    ? `the ten-minute p95 is ${Math.round(health.p95Ms)} ms`
    : health.consecutiveFailures >= 2 ? `the last canary probe failed during ${step} (${code})`
      : `the alert remains active; the latest recorded step is ${step} (${code})`;
  return [{ kind: 'relay-health', id: 'relay-canary', ref: 'relay', at: health.alertSince,
    text: `relay degraded since ${time}; your moves are queued locally (${queued})`,
    what: `${detail}; inspect pullboard relay canary and keep working locally while queued moves await the relay`,
    target: 'relay:relay-canary', step, code, queued }];
}
